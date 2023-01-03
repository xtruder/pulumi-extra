import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

export interface TailscaleServiceLoadBalancerArgs {
  namespace: pulumi.Input<string>;
  version?: pulumi.Input<string>;
  authKey: pulumi.Input<string>;
  proxy?: {
    replicas: pulumi.Input<number>;
  };
}

export class TailscaleServiceLoadBalancer extends pulumi.ComponentResource {
  public chart: k8s.helm.v3.Chart;

  constructor(
    name: string,
    args: TailscaleServiceLoadBalancerArgs,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("pulumi-extra:k8s:TailscaleServiceLoadBalancer", name, {}, opts);

    const {
      namespace,
      version = "1.0.0",
      authKey,
      proxy = { replicas: 1 },
    } = args;

    const defaultResourceOptions: pulumi.ResourceOptions = { parent: this };

    this.chart = new k8s.helm.v3.Chart(
      name,
      {
        chart: "tailscale-svc-lb",
        version,
        namespace,
        fetchOpts: {
          repo: "https://clrxbl.github.io/tailscale-svc-lb/",
        },
        values: {
          fullnameOverride: name,
          tailscaleAuthKey: authKey,
          proxy: {
            deploymentReplicas: proxy.replicas,
          },
        },
      },
      defaultResourceOptions
    );
  }
}
