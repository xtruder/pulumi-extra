import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

export interface KubevirtArgs {
  release?: string;
  cdiRelease?: string;
}

export class Kubevirt extends pulumi.ComponentResource {
  constructor(args: KubevirtArgs = {}, opts?: pulumi.ComponentResourceOptions) {
    super("pulumi-extra:k8s:Kubevirt", "kubevirt", {}, opts);

    const { release = "v0.58.0", cdiRelease = "v1.55.2" } = args;

    const defaultResourceOptions: pulumi.ResourceOptions = { parent: this };

    const kubevirtOperator = new k8s.yaml.ConfigFile(
      "kubevirt-operator",
      {
        file: `https://github.com/kubevirt/kubevirt/releases/download/${release}/kubevirt-operator.yaml`,
      },
      defaultResourceOptions
    );

    const kubevirtCr = new k8s.yaml.ConfigFile(
      "kubevirt-cr",
      {
        file: `https://github.com/kubevirt/kubevirt/releases/download/${release}/kubevirt-cr.yaml`,
      },
      { ...defaultResourceOptions, dependsOn: [kubevirtOperator] }
    );

    const cdiOperator = new k8s.yaml.ConfigFile(
      "cdi-operator",
      {
        file: `https://github.com/kubevirt/containerized-data-importer/releases/download/${cdiRelease}/cdi-operator.yaml`,
      },
      { ...defaultResourceOptions }
    );

    const cdiCr = new k8s.yaml.ConfigFile(
      "cdi-cr",
      {
        file: `https://github.com/kubevirt/containerized-data-importer/releases/download/${cdiRelease}/cdi-cr.yaml`,
      },
      { ...defaultResourceOptions, dependsOn: [cdiOperator] }
    );
  }
}

export interface KubevirtDataVolumeArgs {
  namespace?: pulumi.Input<string>;
  url?: pulumi.Input<string>;
  image?: pulumi.Input<string>;
  size?: pulumi.Input<string>;
  storageClass?: pulumi.Input<string>;
  schedule?: pulumi.Input<string>;
}

export class KubevirtDataImportCron extends pulumi.ComponentResource {
  public name: pulumi.Output<string>;
  public dataImportCron: k8s.apiextensions.CustomResource;

  constructor(
    name: string,
    args: KubevirtDataVolumeArgs,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("pulumi-extra:k8s:KubevirtDataImportCron", name, {}, opts);

    const defaultResourceOptions: pulumi.ResourceOptions = { parent: this };

    let {
      namespace = "kubevirt",
      url,
      image,
      schedule = "0 0 * * *",
      storageClass,
      size = "10Gi",
    } = args;

    this.dataImportCron = new k8s.apiextensions.CustomResource(
      `${name}-data-import-cron`,
      {
        apiVersion: "cdi.kubevirt.io/v1beta1",
        kind: "DataImportCron",
        metadata: {
          name,
          namespace,
        },
        spec: {
          managedDataSource: name,
          schedule,
          template: {
            spec: {
              source: url
                ? { http: { url } }
                : image
                ? { registry: { url: image } }
                : null,
              pvc: {
                storageClassName: storageClass,
                accessModes: ["ReadWriteOnce"],
                resources: { requests: { storage: size } },
              },
            },
          },
        },
      },
      {
        ...defaultResourceOptions,
        deleteBeforeReplace: true,
        replaceOnChanges: ["spec"],
      }
    );

    this.name = this.dataImportCron.metadata.name;
  }
}

export interface KubevirtVirtualMachineArgs {
  namespace: pulumi.Input<string>;
  url?: pulumi.Input<string>;
  image?: pulumi.Input<string>;
  dataVolumeName?: pulumi.Input<string>;
  storageSize?: pulumi.Input<string>;
  storageClass?: pulumi.Input<string>;
  cores?: pulumi.Input<number>;
  memory?: pulumi.Input<string>;
  userData?: pulumi.Input<string>;
}

export class KubevirtVirtualMachine extends pulumi.ComponentResource {
  public dataImportCron: k8s.apiextensions.CustomResource;

  constructor(
    name: string,
    args: KubevirtVirtualMachineArgs,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("pulumi-extra:k8s:KubevirtVirtualMachine", name, {}, opts);

    const defaultResourceOptions: pulumi.ResourceOptions = { parent: this };

    let {
      namespace,
      storageClass,
      storageSize = "10Gi",
      dataVolumeName,
      cores = 8,
      memory = "1024M",
      userData,
      url,
      image,
    } = args;

    this.dataImportCron = new k8s.apiextensions.CustomResource(
      `${name}-virtual-machine`,
      {
        apiVersion: "kubevirt.io/v1",
        kind: "VirtualMachine",
        metadata: { name, namespace },
        spec: {
          running: true,
          template: {
            metadata: {},
            spec: {
              domain: {
                cpu: { cores },
                devices: {
                  disks: [
                    { name: "vmdisk", disk: { bus: "virtio" } },
                    { name: "cloudinitvolume", disk: { bus: "virtio" } },
                  ],
                },
                resources: { requests: { memory } },
              },
              volumes: [
                { name: "vmdisk", dataVolume: { name: `${name}-disk` } },
                {
                  name: "cloudinitvolume",
                  cloudInitNoCloud: { userData },
                },
              ],
            },
          },
          dataVolumeTemplates: [
            {
              metadata: { name: `${name}-disk` },
              spec: {
                pvc: {
                  storageClassName: storageClass,
                  accessModes: ["ReadWriteOnce"],
                  resources: { requests: { storage: storageSize } },
                },
                source: url
                  ? { http: { url } }
                  : image
                  ? { registry: { url: image } }
                  : null,

                // sourceRef: {
                //   namespace,
                //   name: dataVolumeName,
                //   kind: "DataSource",
                // },
              },
            },
          ],
        },
      },
      { ...defaultResourceOptions, deleteBeforeReplace: true }
    );
  }
}
