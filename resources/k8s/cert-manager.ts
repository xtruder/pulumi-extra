import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

export interface CertManagerOpts {
  /** name of the namespace where to deploy cert-manager */
  namespace: pulumi.Input<string>;

  /** version of cert-manager helm chart to deploy (default: ) */
  version?: string;

  /** lets encrypt ClusterIsser options */
  letsencryptClusterIssuer?: {
    /** whether to enable letsencrypt cluster cert issuer */
    enable: boolean;

    /** name of letsencrypt cluster issuer (default: letsencrypt) */
    name?: pulumi.Input<string>;

    /** name of staging letsencrypt cluster issuer (default: letsencrypt-staging) */
    stagingName?: pulumi.Input<string>;

    /** email to use for letsencrypt cert issuer */
    email: pulumi.Input<string>;

    /** name of the ingress class to issue certs for */
    ingressClass?: pulumi.Input<string>;
  };

  selfsignedClusterIsser?: {
    /** whether to enable selfsigned cluster cert issuer */
    enable: boolean;

    /** name of selfsigned cluster issuer (default: selfsigned) */
    name?: pulumi.Input<string>;
  };
}

export class CertManager extends pulumi.ComponentResource {
  public chart: k8s.helm.v3.Chart;

  constructor(
    name: string,
    args: CertManagerOpts,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("pulumi-extra:k8s:CertManager", name, {}, opts);

    let {
      namespace,
      version = "1.10.0",
      selfsignedClusterIsser = {
        enable: true,
      },
      letsencryptClusterIssuer,
    } = args;

    const defaultResourceOptions: pulumi.ResourceOptions = { parent: this };

    // install cert-manager
    const certManager = new k8s.helm.v3.Chart(
      name,
      {
        chart: "cert-manager",
        version,
        namespace,
        fetchOpts: {
          repo: "https://charts.jetstack.io",
        },
        values: {
          installCRDs: true,
        },
      },
      defaultResourceOptions
    );

    if (selfsignedClusterIsser?.enable) {
      // create selfsigned cert issuer
      new k8s.apiextensions.CustomResource(
        `${name}-selfsigned-cluster-issuer`,
        {
          apiVersion: "cert-manager.io/v1",
          kind: "ClusterIssuer",
          metadata: {
            name: selfsignedClusterIsser.name ?? "selfsigned",
            namespace,
          },
          spec: {
            selfSigned: {},
          },
        },
        {
          ...defaultResourceOptions,
          dependsOn: certManager.ready,
          deleteBeforeReplace: true,
        }
      );
    }

    if (letsencryptClusterIssuer) {
      // create production letsencrypt cert issuer
      // create staging letsencrypt cert issuer
      new k8s.apiextensions.CustomResource(
        `${name}-letsencrypt-staging-cluster-issuer`,
        {
          apiVersion: "cert-manager.io/v1",
          kind: "ClusterIssuer",
          metadata: {
            name: letsencryptClusterIssuer.stagingName ?? "letsencrypt-staging",
          },
          spec: {
            acme: {
              server: "https://acme-staging-v02.api.letsencrypt.org/directory",
              email: letsencryptClusterIssuer.email,
              privateKeySecretRef: {
                name:
                  letsencryptClusterIssuer.stagingName ?? "letsencypt-staging",
              },
              solvers: [
                {
                  selector: {},
                  http01: {
                    ingress: {
                      class: letsencryptClusterIssuer.ingressClass,
                    },
                  },
                },
              ],
            },
          },
        },
        {
          ...defaultResourceOptions,
          dependsOn: certManager.ready,
          deleteBeforeReplace: true,
        }
      );

      // create production letsencrypt cert issuer
      new k8s.apiextensions.CustomResource(
        `${name}-letsencrypt-cluster-issuer`,
        {
          apiVersion: "cert-manager.io/v1",
          kind: "ClusterIssuer",
          metadata: {
            name: letsencryptClusterIssuer.name ?? "letsencrypt",
          },
          spec: {
            acme: {
              server: "https://acme-v02.api.letsencrypt.org/directory",
              email: letsencryptClusterIssuer.email,
              privateKeySecretRef: {
                name: letsencryptClusterIssuer.name ?? "letsencrypt",
              },
              solvers: [
                {
                  selector: {},
                  http01: {
                    ingress: {
                      class: letsencryptClusterIssuer.ingressClass,
                    },
                  },
                },
              ],
            },
          },
        },
        {
          ...defaultResourceOptions,
          dependsOn: certManager.ready,
          deleteBeforeReplace: true,
        }
      );
    }

    this.chart = certManager;
  }
}
