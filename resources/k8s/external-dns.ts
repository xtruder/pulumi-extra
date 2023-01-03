import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

import { optional } from "../utils";

export interface ExternalDNSOpts {
  /** name of the namespace where to deploy external-dns chart */
  namespace: pulumi.Input<string>;

  /** version of image to deploy */
  version?: pulumi.Input<string>;

  /** sources to use for dns */
  source?: {
    service?: boolean;
    ingress?: boolean;
  };

  /** domain filter to use (example: cloud.x-truder.net) */
  domainFilter?: pulumi.Input<string>;

  /** filter per domain zone */
  zoneIdFilter?: pulumi.Input<string>;

  /** whether to enable debug logging */
  debug?: boolean;

  /** cloudflare provider options */
  cloudflare?: {
    /** whether requests should be proxied */
    proxied?: boolean;
  } & (
    | {
      /** cloudflare API token */
      apiToken: pulumi.Input<string>;
    }
    | {
      /** cloudflare API key to use */
      apiKey: pulumi.Input<string>;

      /** cloudflare API email to use */
      apiEmail: pulumi.Input<string>;
    }
  );
}

export class ExternalDNS extends pulumi.ComponentResource {
  public chart: k8s.helm.v3.Chart;

  constructor(
    name: string,
    args: ExternalDNSOpts,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("pulumi-extra:k8s:ExternalDNS", name, {}, opts);

    const {
      namespace,
      version = "0.13.1",
      source = { ingress: true, service: true },
      domainFilter,
      zoneIdFilter,
      debug,
      cloudflare,
    } = args;

    const providerName = args.cloudflare ? "cloudflare" : "inmemory";

    const defaultResourceOptions: pulumi.ResourceOptions = { parent: this };

    const clusterRole = new k8s.rbac.v1.ClusterRole(
      `${name}-cr`,
      {
        kind: "ClusterRole",
        metadata: {
          name,
        },
        rules: [
          {
            apiGroups: [""],
            resources: ["services", "endpoints", "pods"],
            verbs: ["get", "watch", "list"],
          },
          {
            apiGroups: ["extensions", "networking.k8s.io"],
            resources: ["ingresses"],
            verbs: ["get", "watch", "list"],
          },
          {
            apiGroups: [""],
            resources: ["nodes"],
            verbs: ["list"],
          },
        ],
      },
      defaultResourceOptions
    );

    const serviceAccount = new k8s.core.v1.ServiceAccount(
      `${name}-sa`,
      {
        kind: "ServiceAccount",
        metadata: {
          name,
          namespace,
        },
      },
      defaultResourceOptions
    );

    new k8s.rbac.v1.ClusterRoleBinding(
      `${name}-crb`,
      {
        kind: "ClusterRoleBinding",
        metadata: {
          name,
        },
        roleRef: {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "ClusterRole",
          name: clusterRole.metadata.name,
        },
        subjects: [
          {
            kind: "ServiceAccount",
            name: serviceAccount.metadata.name,
            namespace,
          },
        ],
      },
      defaultResourceOptions
    );

    const envSecrets = new k8s.core.v1.Secret(`${name}-secret`, {
      metadata: {
        name,
        namespace,
      },
      stringData: {
        ...(cloudflare &&
          ("apiToken" in cloudflare
            ? { CF_API_TOKEN: cloudflare.apiToken }
            : {
              CF_API_KEY: cloudflare?.apiKey,
              CF_API_EMAIL: cloudflare?.apiEmail,
            })),
      },
    });

    new k8s.apps.v1.Deployment(
      `${name}-deployment`,
      {
        kind: "Deployment",
        metadata: {
          name,
          namespace,
        },
        spec: {
          strategy: {
            type: "Recreate",
          },
          selector: {
            matchLabels: {
              app: name,
            },
          },
          template: {
            metadata: {
              labels: {
                app: name,
              },
            },
            spec: {
              serviceAccountName: serviceAccount.metadata.name,
              containers: [
                {
                  name: "external-dns",
                  image: pulumi.interpolate`k8s.gcr.io/external-dns/external-dns:v${version}`,
                  args: [
                    `--provider=${providerName}`,
                    `--log-level=${debug ? "debug" : "info"}`,
                    ...optional(source?.ingress, "--source=ingress"),
                    ...optional(source?.service, "--source=service"),
                    ...optional(
                      domainFilter,
                      pulumi.interpolate`--domain-filter=${domainFilter}`
                    ),
                    ...optional(
                      zoneIdFilter,
                      pulumi.interpolate`--zone-id-filter=${zoneIdFilter}`
                    ),
                    ...optional(cloudflare?.proxied, `--cloudflare-proxied`),
                  ],
                  envFrom: [
                    {
                      secretRef: {
                        name: envSecrets.metadata.name,
                      },
                    },
                  ],
                },
              ],
            },
          },
        },
      },
      defaultResourceOptions
    );
  }
}
