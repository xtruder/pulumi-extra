import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

export interface JupyterLabOpts {
  /** name of the namespace where to deploy jupyter-hub */
  namespace: pulumi.Input<string>;

  /** version of jupyter-hub helm chart to deploy (default: ) */
  version?: string;

  /** storage class to use for storage of user data */
  storageClass: pulumi.Input<string>;

  /** storage size */
  storageSize: pulumi.Input<string>;

  /** github auth configuration */
  githubOAuth?: {
    clientId: pulumi.Input<string>;
    clientSecret: pulumi.Input<string>;
    callbackURL: pulumi.Input<string>;
    allowedOrganizations: pulumi.Input<string[]>;
  };
}

export class JupyterLab extends pulumi.ComponentResource {
  public chart: k8s.helm.v3.Chart;

  constructor(
    name: string,
    args: JupyterLabOpts,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("pulumi-extra:k8s:JupyterLab", name, {}, opts);

    let { namespace, version = "2.0.0", githubOAuth } = args;

    const defaultResourceOptions: pulumi.ResourceOptions = { parent: this };

    // install cert-manager
    const jupyterLab = new k8s.helm.v3.Chart(
      name,
      {
        chart: "jupyterhub",
        version,
        namespace,
        fetchOpts: {
          repo: "https://jupyterhub.github.io/helm-chart/",
        },
        values: {
          hub: {
            config: {
              ...(githubOAuth && {
                GitHubOAuthenticator: {
                  client_id: githubOAuth.clientId,
                  client_secret: githubOAuth.clientSecret,
                  oauth_callback_url: githubOAuth.callbackURL,
                  scope: ["read:org"],
                },
                JupyterHub: {
                  authenticator_class: "github",
                },
              }),
            },
          },
          singleuser: {
            defaultUrl: "/lab",
            image: {
              name: "ghcr.io/xtruder/jupyter-gpu",
              tag: "latest",
            },
            allowPrivilegeEscalation: true,
            cmd: null,
            profileList: [
              {
                display_name: "GPU Server",
                description: "Spawns a notebook server with access to a GPU",
                kubespawner_override: {
                  extra_resource_limits: {
                    "nvidia.com/gpu": "1",
                  },
                },
              },
            ],
            extraEnv: {
              JUPYTERHUB_SINGLEUSER_APP: "jupyter_server.serverapp.ServerApp",
            },
          },
          proxy: {
            service: {
              type: "ClusterIP",
            },
          },
        },
      },
      defaultResourceOptions
    );

    this.chart = jupyterLab;
  }
}
