
import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import * as random from '@pulumi/random';

import { OperatorSubscription } from './olm';
import { WithRequired, PartialBy, deepMerge, base64Decode } from '../util';
import { waitK8SCustomResourceCondition, waitK8SService, waitK8SSecret } from '../../utils';

interface StrimziKafkaOperatorArgs {
    namespace?: pulumi.Input<string>;
}

export class StrimziKafkaOperator extends pulumi.ComponentResource {
    constructor(args: StrimziKafkaOperatorArgs, opts?: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:k8s:StrimiziOperator", "strimzi-kafka-operator", {}, opts);

        const defaultResourceOptions: pulumi.ResourceOptions = { parent: this };

        let {
            namespace = "operators"
        } = args;

        new OperatorSubscription("strimzi-kafka-operator", {
            namespace,
            channel: "stable",
            operatorName: "strimzi-kafka-operator",
            source: "operatorhubio-catalog"
        }, { ...defaultResourceOptions });
    }
}

type KafkaAuthenticationType = null | "tls" | "scram-sha-512";
type KafkaAuthorizationType = null | "simple";

interface KafkaArgs {
    namespace: pulumi.Input<string>;
    replicas?: pulumi.Input<number>;
    inSyncReplicas?: pulumi.Input<number>;
    replicationFactor?: pulumi.Input<number>;
    enableSSL?: boolean;
    enableExternalListener?: Boolean;
    authenticationType?: KafkaAuthenticationType;
    authorizationType?: KafkaAuthorizationType;
    storage?: {
        size?: pulumi.Input<string>;
        class?: pulumi.Input<"ephemeral" | "persistent-claim">;
        [x: string]: any;
    };
    zookeeper?: {
        replicas?: pulumi.Input<number>;
        storage: {
            size?: pulumi.Input<string>;
            class?: pulumi.Input<"ephemeral" | "persistent-claim">;
            [x: string]: any;
        }
    }
    extraConfig?: object;
}

export class Kafka extends pulumi.ComponentResource {
    public readonly name: pulumi.Output<string>;
    public readonly namespace: pulumi.Output<string>;
    public readonly clusterCACert: pulumi.Output<string | undefined>;
    public readonly clusterCACertSecretName: pulumi.Output<string>;
    public readonly bootstrapServers: pulumi.Output<string>;
    public readonly authenticationType: KafkaAuthenticationType;
    public readonly authorizationType: KafkaAuthorizationType;

    public readonly admin: KafkaUser;
    public readonly customResource: k8s.apiextensions.CustomResource;

    private readonly provider: k8s.Provider;

    constructor(name: string, args: KafkaArgs, opts: WithRequired<pulumi.ComponentResourceOptions, 'provider'>) {
        super("pulumi-extra:k8s:Kafka", name, {}, opts);

        this.provider = opts.provider;

        let replicas = pulumi.output(args.replicas || 1);

        let {
            namespace,
            inSyncReplicas = replicas.apply(replicas => replicas > 2 ? 2 : 1 || 1),
            replicationFactor = replicas.apply(replicas => replicas > 2 ? 3 : 1 || 1),
            extraConfig = {},
            enableSSL = true,
            enableExternalListener = false,
            authenticationType = null,
            authorizationType = null,
            storage = {
                type: "ephemeral"
            },
        } = args;

        let {
            replicas: zkReplicas = pulumi.output(replicas).apply(replicas => replicas > 2 ? 3 : 1 || 1),
            storage: zkStorage = {
                type: "ephemeral"
            }
        } = args.zookeeper || {};

        let auth = authenticationType && {authentication: {
            type: authenticationType
        }};

        let spec = deepMerge({
            kafka: {
                "version": "2.7.0",
                "replicas": replicas,
                "listeners": [
                    ...(enableSSL ? [
                        {
                            "name": "tls",
                            "port": 9093,
                            "type": "internal",
                            "tls": true,
                            ...auth
                        },
                    ] : [{
                        "name": "plain",
                        "port": 9092,
                        "type": "internal",
                        "tls": false,
                    }]),
                    ...(enableExternalListener ? [{
                        name: "external",
                        port: 9094,
                        type: "loadbalancer",
                        tls: true,
                        ...auth
                    }] : []),
                ],
                ...(authorizationType && {authorization: {
                    type: authorizationType
                }}),
                "config": {
                    "offsets.topic.replication.factor": replicationFactor,
                    "transaction.state.log.replication.factor": replicationFactor,
                    "transaction.state.log.min.isr": inSyncReplicas,
                    "log.message.format.version": "2.7",
                    "inter.broker.protocol.version": "2.7"
                },
                storage
            },
            zookeeper: {
                "replicas": zkReplicas,
                "storage": zkStorage
            },
            entityOperator: {
                "topicOperator": {},
                "userOperator": {}
            }
        }, extraConfig);

        // only one grafana per namespace is currently supported
        const kafka = waitK8SCustomResourceCondition(new k8s.apiextensions.CustomResource(name, {
            apiVersion: "kafka.strimzi.io/v1beta1",
            kind: "Kafka",
            metadata: {
                namespace,
            },
            spec
        }, { parent: this }), "kafkas", isReady, opts.provider);

        this.customResource = kafka;
        this.name = kafka.metadata.name;
        this.namespace = kafka.metadata.namespace;

        if (authorizationType) {
            this.admin = new KafkaUser(name, {
                name: pulumi.interpolate `${this.name}-admin`,
                namespace: this.namespace,
                clusterName: this.name,
                authenticationType,
                authorizationType,
                acls: [
                    {
                        resource: {
                            type: "topic",
                            name: "*",
                            patternType: "literal" 
                        },
                        host: "*",
                        operation: "All"
                    },
                    {
                        resource: {
                            type: "group",
                            name: "*",
                            patternType: "literal" 
                        },
                        host: "*",
                        operation: "All"
                    },
                    {
                        resource: {
                            type: "cluster"
                        },
                        host: "*",
                        operation: "All"
                    }

                ]
            }, { parent: this, provider: this.provider, dependsOn: [ kafka ] });
        }

        const kafkaInfo = kafka.resource.apply(value => {
            const expectedListenerType = "tls";

            for (const listener of value?.status?.listeners || []) {
                if (listener?.type == expectedListenerType) {
                    return {
                        bootstrapServers: listener?.bootstrapServers as string,
                        certificates: listener?.certificates as string[]
                    };
                }
            }
        });

        this.bootstrapServers = kafkaInfo.apply(value => value?.bootstrapServers || "");
        this.clusterCACert = kafkaInfo.apply(value => value?.certificates[0]);
        this.clusterCACertSecretName = this.name.apply(name => `${name}-cluster-ca-cert`);
        this.authorizationType = authorizationType;
        this.authenticationType = authenticationType;
    }

    newTopic(name: string, args?: Omit<KafkaTopicArgs, 'namespace' | 'clusterName'>, opts?: pulumi.ComponentResourceOptions): KafkaTopic {
        return new KafkaTopic(name, {
            ...args || {},
            namespace: this.namespace,
            clusterName: this.name
        }, { parent: this, provider: this.provider })
    }

    newUser(name: string, args: Omit<KafkaUserArgs, 'namespace' | 'clusterName'>, opts?: pulumi.ComponentResourceOptions): KafkaUser {
        return new KafkaUser(name, {
            ...args,
            authenticationType: this.authenticationType,
            authorizationType: this.authorizationType,
            namespace: this.namespace,
            clusterName: this.name
        }, { parent: this, provider: this.provider });
    }

    newConnect(name: string,
        args: PartialBy<Omit<KafkaConnectArgs, 'namespace' | 'bootstrapServers'>, 'config'> & {
            user?: Partial<KafkaUserArgs>;
        },
        opts?: pulumi.ComponentResourceOptions): KafkaConnect {

        const genConnectSuffix = new random.RandomString(name, {
            length: 8,
            special: false,
            upper: false
        }, { parent: this });

        const connectName = pulumi.interpolate `${name}-${genConnectSuffix.result}`;

        const connectClusterGroupId = connectName;
        const connectClusterOffsetsTopic = pulumi.interpolate `${connectName}-offsets`;
        const connectClusterStatusTopic = pulumi.interpolate `${connectName}-status`;
        const connectClusterConfigsTopic = pulumi.interpolate `${connectName}-configs`;

        let connectUser: KafkaUser | undefined;
        if (this) {

            const acls: KafkaUserAcl[] = [];

            for (const topic of [
                connectClusterOffsetsTopic,
                connectClusterStatusTopic,
                connectClusterConfigsTopic
            ]) {
                for (const operation of ["Read", "Write", "Create", "Describe"]) {
                    acls.push({
                        resource: {
                            type: "topic",
                            name: topic,
                            patternType: "literal"
                        },
                        operation: operation as any,
                        host: "*"
                    })
                }
            }

            acls.push({
                resource: {
                    type: "group",
                    name: connectClusterGroupId,
                    patternType: "literal"
                },
                operation: "Read",
                host: "*"
            });

            const userArgs = args.user;
            const extraAcls = userArgs?.acls || [];

            connectUser = new KafkaUser(name, {
                name: pulumi.interpolate `${connectName}-user`,
                namespace: this.namespace,
                clusterName: this.name,
                authenticationType: this.authenticationType,
                authorizationType: this.authorizationType,
                acls: [...acls, ...extraAcls as any]
            }, { parent: this, provider: this.provider });
        }

        const connect = new KafkaConnect(name, {
            ...args,
            name: connectName,
            namespace: this.namespace,
            bootstrapServers: this.bootstrapServers,
            trustedCASecretName: this.clusterCACertSecretName,
            ...(this.authenticationType == "tls" && {tlsAuthentication: {
                secretName: (connectUser as KafkaUser).name,
                certificate: "user.crt",
                key: "user.key"
            }}),
            ...(this.authenticationType == "scram-sha-512" && {scramSha512Authentication: {
                username: (connectUser as KafkaUser).name,
                secretName: (connectUser as KafkaUser).name,
                password: "password"
            }}),
            config: {
                ...args?.config || {},
                "group.id": connectClusterGroupId,
                "offset.storage.topic": connectClusterOffsetsTopic,
                "config.storage.topic": connectClusterConfigsTopic,
                "status.storage.topic": connectClusterStatusTopic,
            }
        }, { ...opts, parent: this, provider: this.provider });

        return connect;
    }
}

interface KafkaTopicArgs {
    namespace: pulumi.Input<string>;
    clusterName: pulumi.Input<string>;
    topicName?: pulumi.Input<string>;
    partitions?: pulumi.Input<number>;
    replicas?: pulumi.Input<number>;
    config?: any;
}

export class KafkaTopic extends pulumi.ComponentResource {
    public readonly name: pulumi.Output<string>;
    public readonly namespace: pulumi.Output<string>;

    public readonly customResource: k8s.apiextensions.CustomResource;

    constructor(name: string, args: KafkaTopicArgs, opts: WithRequired<pulumi.ComponentResourceOptions, 'provider'>) {
        super("pulumi-extra:k8s:KafkaTopic", name, {}, opts);

        let {
            namespace,
            clusterName,
            topicName,
            partitions = 1,
            replicas = 1,
            config = {}
        } = args;

        let spec = {
            topicName,
            partitions,
            replicas,
            config
        };

        const topic = waitK8SCustomResourceCondition(new k8s.apiextensions.CustomResource(name, {
            apiVersion: "kafka.strimzi.io/v1beta1",
            kind: "KafkaTopic",
            metadata: {
                namespace,
                labels: {
                    "strimzi.io/cluster": clusterName
                }
            },
            spec
        }, { parent: this }), "kafkatopics", isReady, opts.provider);

        this.customResource = topic;
        this.name = topic.metadata.name;
        this.namespace = topic.metadata.namespace;
    }
}

interface KafkaUserAcl {
    resource: pulumi.Input<{
        type: pulumi.Input<"topic" | "group" | "cluster">;
        name?: pulumi.Input<string>;
        patternType?: pulumi.Input<"literal" | "prefixed">;
    }>,
    operation: pulumi.Input<"Read" | "Write" | "Create" | "Describe" | "All">
    host: pulumi.Input<string>;
}

interface KafkaUserArgs {
    name?: pulumi.Input<string>;
    namespace: pulumi.Input<string>;
    clusterName: pulumi.Input<string>;
    authenticationType?: KafkaAuthenticationType;
    authorizationType?: KafkaAuthorizationType;
    acls: pulumi.Input<pulumi.Input<KafkaUserAcl>[]>;
    extraConfig?: any;
}

export class KafkaUser extends pulumi.ComponentResource {
    public readonly name: pulumi.Output<string>;
    public readonly namespace: pulumi.Output<string>;

    public readonly password: pulumi.Output<string>;
    public readonly userCert: pulumi.Output<string>;
    public readonly userKey: pulumi.Output<string>;
    public readonly properties: pulumi.Output<string>;

    public readonly customResource: k8s.apiextensions.CustomResource;

    constructor(name: string, args: KafkaUserArgs, opts: WithRequired<pulumi.ComponentResourceOptions, 'provider'>) {
        super("pulumi-extra:k8s:KafkaUser", name, {}, opts);

        let {
            name: userName,
            namespace,
            clusterName,
            authenticationType = null,
            authorizationType = null,
            acls,
            extraConfig
        } = args;

        let spec = {
            ...(authenticationType && {authentication: {
                type: authenticationType
            }}),
            ...(authorizationType && {authorization: {
                type: authorizationType,
                acls
            }}),
        };

        const user = waitK8SCustomResourceCondition(new k8s.apiextensions.CustomResource(name, {
            apiVersion: "kafka.strimzi.io/v1beta1",
            kind: "KafkaUser",
            metadata: {
                ...(userName && {name: userName}),
                namespace,
                labels: {
                    "strimzi.io/cluster": clusterName
                }
            },
            spec
        }, { parent: this }), "kafkausers", isReady, opts.provider);

        this.customResource = user;
        this.name = user.metadata.name;
        this.namespace = user.metadata.namespace;

        const userSecrets = waitK8SSecret(
            this.namespace,
            this.name,
            opts.provider,
            user
        );

        if (authenticationType == "tls") {
            this.userCert =
                userSecrets.apply(secrets => base64Decode(secrets?.data?.["user.crt"]));
            this.userKey =
                pulumi.secret(userSecrets.apply(secrets => base64Decode(secrets?.data?.["user.key"])));
        }

        if (authenticationType == "scram-sha-512") {
            this.password = 
                pulumi.secret(userSecrets.apply(secrets => base64Decode(secrets?.data?.["password"])));
        }
    }
}

interface KafkaConnectArgs {
    namespace: pulumi.Input<string>;
    name?: pulumi.Input<string>;
    version?: pulumi.Input<string>;
    replicas?: pulumi.Input<number>;
    bootstrapServers: pulumi.Input<string>;
    tlsAuthentication?: {
        certificate: pulumi.Input<string>;
        key: pulumi.Input<string>;
        secretName: pulumi.Input<string>;
    };
    scramSha512Authentication?: {
        secretName: pulumi.Input<string>;
        username: pulumi.Input<string>;
        password: pulumi.Input<string>;
    };
    trustedCASecretName?: pulumi.Input<string>;
    useConntectorResource?: pulumi.Input<boolean>;
    config: pulumi.Input<object>;
    extraSpec?: pulumi.Input<object>;
}

export class KafkaConnect extends pulumi.ComponentResource {
    public readonly name: pulumi.Output<string>;
    public readonly namespace: pulumi.Output<string>;
    public readonly customResource: k8s.apiextensions.CustomResource;

    private readonly provider: k8s.Provider;

    constructor(name: string, args: KafkaConnectArgs, opts: WithRequired<pulumi.ComponentResourceOptions, 'provider'>) {
        super("pulumi-extra:k8s:KafkaConnect", name, {}, opts);

        this.provider = opts.provider;

        let {
            namespace,
            name: connectName,
            version = "2.7.0",
            replicas = 1,
            bootstrapServers,
            trustedCASecretName,
            tlsAuthentication,
            scramSha512Authentication,
            useConntectorResource = true,
            config,
            extraSpec: extraConfig = {}
        } = args;

        let spec = deepMerge({
            version,
            replicas,
            bootstrapServers,
            ...(trustedCASecretName && {tls: {
                trustedCertificates: [{
                    secretName: trustedCASecretName,
                    certificate: "ca.crt"
                }]
            }}),
            ...(tlsAuthentication && {authentication: {
                type: "tls",
                certificateAndKey: tlsAuthentication
            }}),
            ...(scramSha512Authentication && {authentication: {
                type: "scram-sha-512",
                username: scramSha512Authentication.username,
                passwordSecret: {
                    secretName: scramSha512Authentication.secretName,
                    password: scramSha512Authentication.password
                }
            }}),
            config
        }, extraConfig);

        const connect = new k8s.apiextensions.CustomResource(name, {
            apiVersion: "kafka.strimzi.io/v1beta1",
            kind: "KafkaConnect",
            metadata: {
                ...(connectName && {name: connectName}),
                namespace,
                annotations: {
                    "strimzi.io/use-connector-resources": useConntectorResource ? "true" : "false",
                }
            },
            spec
        }, { parent: this });

        this.customResource = waitK8SCustomResourceCondition(connect, "kafkaconnects", isReady, opts.provider);
        this.namespace = pulumi.output(namespace);
        this.name = this.customResource.metadata.name;
    }

    newConnector(name: string, args: Omit<KafkaConnectorArgs, 'namespace' | 'clusterName'>, opts?: pulumi.ComponentResourceOptions) {
        return new KafkaConnector(name, {
            ...args,
            namespace: this.namespace,
            clusterName: this.name
        }, { ...opts, parent: this, provider: this.provider });
    }
}

interface KafkaConnectorArgs {
    namespace: pulumi.Input<string>;
    clusterName: pulumi.Input<string>;
    class: pulumi.Input<string>;
    taskMax: pulumi.Input<number>;
    config: pulumi.Input<object>;
}

export class KafkaConnector extends pulumi.ComponentResource {
    public readonly name: pulumi.Output<string>;
    public readonly customResource: k8s.apiextensions.CustomResource;

    constructor(name: string, args: KafkaConnectorArgs, opts: WithRequired<pulumi.ComponentResourceOptions, 'provider'>) {
        super("pulumi-extra:k8s:KafkaConnector", name, {}, opts);

        let {
            namespace,
            clusterName,
            class: connectorClass,
            taskMax = 1,
            config
        } = args;

        const connector = new k8s.apiextensions.CustomResource(name, {
            apiVersion: "kafka.strimzi.io/v1alpha1",
            kind: "KafkaConnector",
            metadata: {
                namespace,
                labels: {
                    "strimzi.io/cluster": clusterName
                }
            },
            spec: {
                class: connectorClass,
                taskMax,
                config
            }
        }, { parent: this });

        this.customResource = waitK8SCustomResourceCondition(connector, "kafkaconnectors", isReady, opts.provider);
    }
}

function isReady(resource: any) {
    for (const condition of resource?.status?.conditions || []) {
        if (condition.type == "Ready" && condition.status == "True") return true;
    }

    return false;
}

export function createKafkaClientProperties(kafka: Kafka, user?: KafkaUser): pulumi.Output<string> {
    const values: Record<string, pulumi.Output<string | undefined> | string | undefined> = {}; 

    values["bootstrap.servers"] = kafka.bootstrapServers;

    if (kafka.clusterCACert) {
        values["ssl.truststore.type"] = "PEM";
        values["ssl.truststore.certificates"] = kafka.clusterCACert.apply(v => v?.trim());
    }

    switch (kafka.authenticationType) {
        case "tls":
            if (!user) {
                throw new Error("user not provided");
            }

            values["security.protocol"] = "SSL";
            values["ssl.keystore.type"] = "PEM";
            values["ssl.keystore.key"] = user.userKey.apply(v => v.trim());
            values["ssl.keystore.certificate.chain"] = user.userCert.apply(v => v.trim());
            break;
        case "scram-sha-512":
            values["security.protocol"] = "SASL_SSL";
            values["sasl.mechanism"] = "SCRAM-SHA-512";
            values["sasl.jaas.config"] = pulumi.interpolate
                `org.apache.kafka.common.security.scram.ScramLoginModule required username="${user?.name}" password="${user?.password}";`;
            break;
    }

    return pulumi.all(values).apply(values => {
        let results = [];

        for (let [key, value] of Object.entries(values)) {
            if (!value) continue;

            if (value.includes("\n")) {
                value = value.split("\n").join(" \\\n")
            }

            results.push(`${key}=${value}`);
        }

        return results.join("\n");
    });
}