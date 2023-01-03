import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

export interface RotkiOpts {
  namespace: pulumi.Input<string>;
  version?: pulumi.Input<string>;
  persistence?: {
    enable: boolean;
    storageClassName: pulumi.Input<string>;
  };
}

export class Rotki extends pulumi.ComponentResource {
  public deployment: k8s.apps.v1.Deployment;
  public service: k8s.core.v1.Service;

  constructor(
    name: string,
    args: RotkiOpts,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("pulumi-extra:k8s:Rotki", name, {}, opts);

    const { namespace, version = "v1.21.1", persistence } = args;

    const defaultResourceOptions: pulumi.ResourceOptions = { parent: this };

    const pvcData =
      persistence &&
      new k8s.core.v1.PersistentVolumeClaim(
        `${name}-data-pvc`,
        {
          metadata: {
            name: `${name}-data`,
            namespace,
          },
          spec: {
            storageClassName: persistence?.storageClassName,
            accessModes: ["ReadWriteOnce"],
            resources: {
              requests: {
                storage: "5Gi",
              },
            },
          },
        },
        { ...defaultResourceOptions, deleteBeforeReplace: true }
      );

    const pvcLogs =
      persistence &&
      new k8s.core.v1.PersistentVolumeClaim(
        `${name}-logs-pvc`,
        {
          metadata: {
            name: `${name}-logs`,
            namespace,
          },
          spec: {
            storageClassName: persistence?.storageClassName,
            accessModes: ["ReadWriteOnce"],
            resources: {
              requests: {
                storage: "3Gi",
              },
            },
          },
        },
        { ...defaultResourceOptions, deleteBeforeReplace: true }
      );

    this.deployment = new k8s.apps.v1.Deployment(
      `${name}-deployment`,
      {
        metadata: {
          name,
          namespace,
          labels: {
            app: name,
          },
        },
        spec: {
          replicas: 1,
          selector: {
            matchLabels: {
              app: name,
              version,
            },
          },
          template: {
            metadata: {
              labels: {
                app: name,
                version,
              },
            },
            spec: {
              containers: [
                {
                  name: "rotki",
                  ports: [
                    {
                      name: "http",
                      containerPort: 80,
                    },
                  ],
                  image: `rotki/rotki:${version}`,
                  volumeMounts: persistence
                    ? [
                        {
                          mountPath: "/data",
                          name: "rotki-data",
                        },
                        {
                          mountPath: "/logs",
                          name: "rotki-logs",
                        },
                      ]
                    : [],
                },
              ],
              volumes: persistence
                ? [
                    {
                      name: "rotki-data",
                      persistentVolumeClaim: {
                        claimName: pvcData!.metadata.name,
                      },
                    },
                    {
                      name: "rotki-logs",
                      persistentVolumeClaim: {
                        claimName: pvcLogs!.metadata.name,
                      },
                    },
                  ]
                : [],
            },
          },
        },
      },
      {
        ...defaultResourceOptions,
        deleteBeforeReplace: true,
        // transformations: [
        //   redirectToSocks(
        //     pulumi.interpolate`${torService.spec.clusterIP}:9050`,
        //     torService.spec.clusterIP
        //   ),
        // ],
      }
    );

    this.service = new k8s.core.v1.Service(
      `${name}-service`,
      {
        metadata: {
          name,
          namespace,
        },
        spec: {
          ports: [
            {
              name: "http",
              protocol: "TCP",
              port: 80,
              targetPort: 80,
            },
          ],
          selector: {
            app: name,
          },
        },
      },
      { deleteBeforeReplace: true, dependsOn: [this.deployment] }
    );
  }
}
