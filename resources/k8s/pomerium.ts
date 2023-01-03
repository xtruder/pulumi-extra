import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as tls from "@pulumi/tls";
import * as random from "@pulumi/random";

import { RootSigningCertificate } from "../misc/tls";
import { removeK8SResourceParams } from "../utils";

export interface PomeriumOpts {
  /** namespace to deploy pomerium to */
  namespace: pulumi.Input<string>;

  /** version of pomerium chart to install */
  version?: string;

  /** domain where to deploy pomerium to */
  domain: pulumi.Input<string>;

  /** identity provider options */
  idp: {
    provider: pulumi.Input<string>;
    clientID: pulumi.Input<string>;
    clientSecret: pulumi.Input<string>;
    serviceAccount: pulumi.Input<string>;
  };

  /** ingress options */
  ingress: {
    /** name of the ingress class to use */
    className: pulumi.Input<string>;

    /** cluster cert issuer to use for ingress */
    clusterIssuer: pulumi.Input<string>;
  };

  proxy?: {
    /** proxy type to use */
    type?: pulumi.Input<"NodePort" | "LoadBalancer">;

    /** proxy node port to use */
    nodePort?: pulumi.Input<number>;
  };
}

export class Pomerium extends pulumi.ComponentResource {
  public chart: k8s.helm.v3.Chart;

  constructor(
    name: string,
    args: PomeriumOpts,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("pulumi-extra:k8s:Pomerium", name, {}, opts);

    let {
      namespace,
      version = "33.0.1",
      domain,
      idp: { provider, clientID, clientSecret, serviceAccount },
      ingress: { className, clusterIssuer },
      proxy: { type: proxyType, nodePort: proxyNodePort } = {
        type: "NodePort",
      },
    } = args;

    const defaultResourceOptions: pulumi.ResourceOptions = { parent: this };

    const pomeriumSharedSecret = new random.RandomId(
      `${name}-shared-secret`,
      {
        byteLength: 32,
      },
      defaultResourceOptions
    );

    const pomeriumCookieSecret = new random.RandomId(
      `${name}-cookie-secret`,
      {
        byteLength: 32,
      },
      defaultResourceOptions
    );

    const ca = new RootSigningCertificate(
      `${name}-ca`,
      {},
      defaultResourceOptions
    );

    const pomeriumTlsCa = new k8s.core.v1.Secret(
      `${name}-tls-ca`,
      {
        type: "kubernetes.io/tls",
        metadata: {
          name: `${name}-tls-ca`,
          namespace,
        },
        stringData: {
          "tls.crt": ca.getCertificate(),
          "tls.key": ca.getPrivateKey(),
        },
      },
      { ...defaultResourceOptions, deleteBeforeReplace: true }
    );

    const localCertIssuer = new k8s.apiextensions.CustomResource(
      `${name}-issuer`,
      {
        apiVersion: "cert-manager.io/v1",
        kind: "Issuer",
        metadata: {
          name: `${name}-issuer`,
          namespace,
        },
        spec: {
          ca: {
            secretName: pomeriumTlsCa.metadata.name,
          },
        },
      },
      {
        ...defaultResourceOptions,
        deleteBeforeReplace: true,
      }
    );

    const pomeriumCert = new k8s.apiextensions.CustomResource(
      `${name}-cert`,
      {
        apiVersion: "cert-manager.io/v1",
        kind: "Certificate",
        metadata: {
          name: `${name}-cert`,
          namespace,
        },
        spec: {
          secretName: `${name}-cert`,
          issuerRef: {
            name: localCertIssuer.metadata.name,
            kind: "Issuer",
          },
          usages: ["server auth", "client auth"],
          dnsNames: [
            pulumi.interpolate`authenticate.${domain}`,
            pulumi.interpolate`authorize.${domain}`,
            pulumi.interpolate`pomerium.${domain}`,
            pulumi.interpolate`pomerium-proxy.${namespace}.svc.cluster.local`,
            pulumi.interpolate`pomerium-authorize.${namespace}.svc.cluster.local`,
            pulumi.interpolate`pomerium-databroker.${namespace}.svc.cluster.local`,
            pulumi.interpolate`pomerium-authenticate.${namespace}.svc.cluster.local`,
          ],
        },
      },
      {
        ...defaultResourceOptions,
        deleteBeforeReplace: true,
      }
    );

    const redisPassword = new random.RandomId(
      `${name}-redis-password`,
      {
        byteLength: 32,
      },
      defaultResourceOptions
    );

    const databrokerSecret = new k8s.core.v1.Secret(
      `${name}-databroker`,
      {
        metadata: {
          name: `${name}-databroker`,
          namespace,
        },
        stringData: {
          password: redisPassword.hex,
          DATABROKER_STORAGE_CONNECTION_STRING: pulumi.interpolate`rediss://:${redisPassword.hex}@${name}-redis-master.${namespace}.svc.cluster.local`,
        },
      },
      defaultResourceOptions
    );

    const pomeriumRedisCert = new k8s.apiextensions.CustomResource(
      `${name}-redis-cert`,
      {
        apiVersion: "cert-manager.io/v1",
        kind: "Certificate",
        metadata: {
          name: `${name}-redis-cert`,
          namespace,
        },
        spec: {
          secretName: `${name}-redis-cert`,
          issuerRef: {
            name: localCertIssuer.metadata.name,
            kind: "Issuer",
          },
          dnsNames: [
            pulumi.interpolate`pomerium-redis-master.${namespace}.svc.cluster.local`,
            pulumi.interpolate`pomerium-redis-headless.${namespace}.svc.cluster.local`,
            pulumi.interpolate`pomerium-redis-replicas.${namespace}.svc.cluster.local`,
          ],
        },
      },
      {
        ...defaultResourceOptions,
        deleteBeforeReplace: true,
      }
    );

    const signingKey = new tls.PrivateKey(
      `${name}-signing-key`,
      {
        algorithm: "ECDSA",
        ecdsaCurve: "P256",
      },
      defaultResourceOptions
    );

    const pomerium = new k8s.helm.v3.Chart(
      name,
      {
        chart: "pomerium",
        version,
        namespace,
        fetchOpts: {
          repo: "https://helm.pomerium.io",
        },

        // see values reference: https://www.pomerium.io/docs/quick-start/helm.html#configure
        // for gitlab specific options: https://www.pomerium.com/docs/identity-providers/gitlab.html
        values: {
          config: {
            rootDomain: domain,
            existingCASecret: pomeriumCert.metadata.name,
            generateTLS: false,
            generateSigningKey: false,
            signingKey: signingKey.privateKeyPem.apply((val) =>
              Buffer.from(val).toString("base64")
            ),
            sharedSecret: pomeriumSharedSecret.b64Std,
            cookieSecret: pomeriumCookieSecret.b64Std,
          },
          authenticate: {
            existingTLSSecret: pomeriumCert.metadata.name,
            idp: {
              provider,
              clientID,
              clientSecret,
              serviceAccount,
            },
            ingress: {
              tls: {
                secretName: `${name}-ingress-tls-v1`,
              },
            },
          },
          ingress: {
            enabled: true,
            secretName: `${name}-ingress-tls-v1`,
            className,
            annotations: {
              "kubernetes.io/ingress.class": className,
              "cert-manager.io/cluster-issuer": clusterIssuer,
              "nginx.ingress.kubernetes.io/backend-protocol": "HTTPS",
            },
            tls: {
              hosts: [
                pulumi.interpolate`authenticate.${domain}`,
                pulumi.interpolate`forwardauth.${domain}`,
                pulumi.interpolate`pomerium.${domain}`,
              ],
            },
          },
          authorize: {
            existingTLSSecret: pomeriumCert.metadata.name,
          },
          proxy: {
            existingTLSSecret: `${name}-ingress-tls-v1`,
            service: {
              type: proxyType,
              nodePort: proxyNodePort,
            },
          },
          databroker: {
            existingTLSSecret: pomeriumCert.metadata.name,
            storage: {
              connectionString: pulumi.interpolate`rediss://:${redisPassword.hex}@${name}-redis-master.${namespace}.svc.cluster.local`,
              type: "redis",
              clientTLS: {
                existingSecretName: pomeriumCert.metadata.name,
                existingCASecretKey: "ca.crt",
              },
            },
          },
          forwardAuth: {
            enabled: true,
            internal: false,
          },
          ingressController: {
            enabled: true,
            ingressClassResource: {
              enabled: false,
            },
            config: {
              operatorMode: true,
              ingressClass: "k8s.io/ingress-nginx",
            },
            operatorMode: true,
          },

          redis: {
            enabled: true,
            auth: {
              createSecret: false,
              existingSecret: databrokerSecret.metadata.name,
              existingSecretPasswordKey: "password",
            },
            generateTLS: false,
            tls: {
              enabled: true,
              certificatesSecret: pomeriumRedisCert.metadata.name,
            },
            master: {
              //   persistence: {
              //     storageClass,
              //   },
            },
            cluster: {
              slaveCount: 0,
            },
            replica: {
              replicaCount: 0,
            },
          },
        },
        transformations: [
          // remove as we are not running any replicas and pulumi will wait forever
          removeK8SResourceParams({
            kind: "Service",
            name: `${name}-redis-replicas`,
          }),
        ],
      },
      defaultResourceOptions
    );

    this.chart = pomerium;
  }
}
