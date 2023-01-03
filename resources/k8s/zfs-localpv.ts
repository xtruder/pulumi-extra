import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

export interface ZFSLocalPVStorageOpts {
  namespace: pulumi.Input<string>;
  version?: pulumi.Input<string>;
  kubeletDir?: pulumi.Input<string>;
  zfsBinPath?: pulumi.Input<string>;
}

export class ZFSLocalPVStorage extends pulumi.ComponentResource {
  public chart: k8s.helm.v3.Chart;
  public ready: pulumi.Output<pulumi.CustomResource[]>;

  constructor(
    name: string,
    args: ZFSLocalPVStorageOpts,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("pulumi-extra:k8s:ZFSLocalPVStorage", name, {}, opts);

    const { namespace, version = "2.1.0", kubeletDir, zfsBinPath } = args;

    const defaultResourceOptions: pulumi.ResourceOptions = { parent: this };

    this.chart = new k8s.helm.v3.Chart(
      "zfs-localpv",
      {
        chart: "zfs-localpv",
        version,
        namespace,
        fetchOpts: {
          repo: "https://openebs.github.io/zfs-localpv",
        },
        values: {
          zfsNode: {
            kubeletDir,
          },
          analytics: {
            enabled: false,
          },
          zfs: {
            bin: zfsBinPath,
          },
        },
      },
      defaultResourceOptions
    );

    this.ready = this.chart.ready;
  }
}
