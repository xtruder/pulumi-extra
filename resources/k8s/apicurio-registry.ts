import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';

import { includeK8SResourceParams, removeK8SResourceParams, waitK8SCustomResourceCondition, waitK8SDeployment } from '../../utils/k8s';
import { WithRequired } from '../util';
import { strimzi } from '..';
import { Kafka } from './strimzi';

const
    version = "c23363a98",
    install = `https://raw.githubusercontent.com/Apicurio/apicurio-registry-operator/${version}/docs/resources/install.yaml`;

export class CRDs extends pulumi.ComponentResource {
    constructor(opts?: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:k8s:ApicurioRegistryOperatorCRDs", "apicurio-registry-operator-crds", {}, opts);

        // install apicurio registry operator in sepcific namespace
        new k8s.yaml.ConfigFile("apicurio-registry-operator", {
            file: install,
            transformations: [
                includeK8SResourceParams({kind: "CustomResourceDefinition"})
            ]
        }, { parent: this });
    }
}

interface OperatorArgs {
    /**
     * Namespace where to install apicurio registry operator
     */
    namespace: pulumi.Input<string>;

    /**
     * Whether to install operator CustomResourceDefinitions (default true).
     * CustomResourceDefinitions associated with this operator can be also installed separately.
     */
    installCRDs?: boolean;
}

export class Operator extends pulumi.ComponentResource {
    constructor(args: OperatorArgs, opts: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:k8s:ApicurioRegistryOperator", "apicurio-registry-operator", {}, opts);

        let {
            namespace,
            installCRDs = true
        } = args;

        pulumi.output(namespace).apply(namespace => new k8s.yaml.ConfigFile("apicurio-registry-operator", {
            file: install,
            transformations: [
                ...(installCRDs ? [] : [removeK8SResourceParams({kind: "CustomResourceDefinition"})]),

                ((resource) => {
                    resource.metadata.namespace = namespace;
                }),
                ((resource) => {
                    if (resource.kind === "ClusterRoleBinding") {
                        resource.metadata.name = `${namespace}-${resource.metadata.name}`;
                        resource.roleRef.name = `${namespace}-${resource.roleRef.name}`;
                        resource.subjects[0].namespace = namespace;
                    }

                    if (resource.kind === "ClusterRole") {
                        resource.metadata.name = `${namespace}-${resource.metadata.name}`;
                    }
                }),
            ]
        }, { parent: this }));
    }
}

interface RegistryArgs {
    /**
     * Namespace where to deploy registry
     */
    namespace: pulumi.Input<string>;

    /**
     * Name of the registry
     */
    name?: pulumi.Input<string>;

    /**
     * Uses kafka streams for persistence
     */
    streams?: {
        bootstrapServers: pulumi.Input<string>;
        scram?: {
            truststoreSecretName: pulumi.Input<string>;
            user: pulumi.Input<string>;
            passwordSecretName: pulumi.Input<string>;
        };
    };

    /**
     * Use existing strimzi Kafka for persistence,
     * creates required topics and users in kafka
     */
    kafka?: Kafka;
}

export class Registry extends pulumi.ComponentResource {
    public readonly customResource: k8s.apiextensions.CustomResource;
    public readonly serviceName: pulumi.Output<string>;

    constructor(name: string, args: RegistryArgs, opts: WithRequired<pulumi.ComponentResourceOptions, 'provider'>) {
        super("pulumi-extra:k8s:ApicurioRegistry", name, {}, opts);

        const defaultResourceOptions: pulumi.ResourceOptions = { parent: this };

        let {
            namespace,
            name: resourceName,
            streams,
            kafka
        } = args;

        if (kafka) {
            let user: strimzi.KafkaUser | undefined;
            if (kafka.authenticationType) {
                user = kafka.newUser("registry", {
                    name: "registry",
                    acls: [
                        {
                            operation: "All",
                            resource: {
                                name: "*",
                                patternType: "literal",
                                type: "topic"
                            },
                            host: "*"
                        },
                        {
                            operation: "All",
                            resource: {
                                name: "*",
                                patternType: "literal",
                                type: "cluster"
                            },
                            host: "*"
                        },
                        {
                            operation: "All",
                            resource: {
                                name: "*",
                                patternType: "literal",
                                type: "transactionalId"
                            },
                            host: "*"
                        },
                        {
                            operation: "All",
                            resource: {
                                name: "*",
                                patternType: "literal",
                                type: "group"
                            },
                            host: "*"
                        },
                    ]

                });
            }

            kafka.newTopic("registry-global-id-topic", {
                topicName: "global-id-topic"
            });

            kafka.newTopic("registry-storage-topic", {
                topicName: "storage-topic"
            });

            streams = {
                bootstrapServers: kafka.bootstrapServers,
                ...(kafka.authenticationType == 'scram-sha-512' && user && {scram: {
                    truststoreSecretName: kafka.clusterCACertSecretName,
                    user: user.name,
                    passwordSecretName: user.name
                }})
            };
        }

        let persistence: string = "mem";
        if (streams) {
            persistence = "streams";
        }

        const registry = waitK8SCustomResourceCondition(
            new k8s.apiextensions.CustomResource(name, {
                apiVersion: "apicur.io/v1alpha1",
                kind: "ApicurioRegistry",
                metadata: {
                    namespace,
                    ...(resourceName && {name: resourceName})
                },
                spec: {
                    configuration: {
                        persistence,
                        ...(streams && {streams: {
                            bootstrapServers: streams.bootstrapServers,
                            security: {
                                ...(streams.scram && {scram: streams.scram})
                            }
                        }})
                    }
                }
            }, {...defaultResourceOptions, deleteBeforeReplace: true}),
            resource => {
                if (resource?.status?.replicaCount > 0 && resource?.status?.serviceName) {
                    return true
                }

                return false;
            },
        opts.provider);

        const deployment = waitK8SDeployment(
            namespace,
            registry.body.apply(resource => resource?.status?.deploymentName),
            opts.provider,
            this
        );

        let finalRegistry = pulumi.all([registry, deployment]).apply(([registry]) => registry);

        this.customResource = registry;
        this.serviceName = finalRegistry.body.
            apply(resource => resource?.status?.serviceName as string);
    }
}
