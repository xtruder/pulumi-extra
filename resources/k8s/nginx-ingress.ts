import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { all } from "@pulumi/pulumi";

export interface NginxIngressOpts {
  /** name of the namespace where to deploy nginx-ingress */
  namespace: pulumi.Input<string>;

  /** version of nginx ingress to deploy */
  version?: string;

  /** ingress class to watch */
  ingressClass?: pulumi.Input<string>;

  /** whether to use host networking */
  hostNetwork?: pulumi.Input<boolean>;

  /** whether this is default ingress */
  defaultIngress?: pulumi.Input<boolean>;

  /** whether to use LoadBalancer or NodePort service type for nginx ingress */
  ingressServiceType?: pulumi.Input<"LoadBalancer" | "NodePort">;

  /** list of external ips if using NodePort service type */
  ingressExternalIPs?: pulumi.Input<string>[];
}

export class NginxIngress extends pulumi.ComponentResource {
  public chart: k8s.helm.v3.Chart;
  public ready: pulumi.Output<pulumi.CustomResource[]>;

  constructor(
    name: string,
    args: NginxIngressOpts,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("pulumi-extra:k8s:NginxIngress", name, {}, opts);

    let {
      namespace,
      version = "4.3.0",
      ingressClass = "nginx",
      ingressServiceType = "LoadBalancer",
      ingressExternalIPs,
      defaultIngress = false,
      hostNetwork = false,
    } = args;

    const defaultResourceOptions: pulumi.ResourceOptions = { parent: this };

    // install nginx-ingress
    const nginxIngres = new k8s.helm.v3.Chart(
      name,
      {
        chart: "ingress-nginx",
        version,
        fetchOpts: {
          repo: "https://kubernetes.github.io/ingress-nginx",
        },
        namespace,
        values: {
          controller: {
            ingressClass,
            ingressClassResource: {
              name: ingressClass,
              default: defaultIngress,
            },
            hostNetwork,
            kind: hostNetwork ? "DaemonSet" : "Deployment",
            service: {
              enabled: !!!hostNetwork,

              // we use NodePort for listening on static ports,
              // later we will use iptables to redirect traffic from 80 and 443
              // to asigned node ports
              type: ingressServiceType,
              ...(ingressExternalIPs && { externalIPs: ingressExternalIPs }),
              ...(ingressExternalIPs && { externalTrafficPolicy: "Local" }),
            },
          },
        },
      },
      defaultResourceOptions
    );

    this.chart = nginxIngres;
    this.ready = nginxIngres.ready;
  }
}
