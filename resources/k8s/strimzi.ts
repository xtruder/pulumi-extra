import * as path from 'path';
import deepMerge from "ts-deepmerge";

import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import * as random from '@pulumi/random';
import * as docker from "@pulumi/docker";

import { WithRequired, PartialBy, base64Decode, writeTmpFiles, fromEntries } from '../util';
import { waitK8SCustomResourceCondition, waitK8SSecret, waitK8SDeployment, includeK8SResourceParams, removeK8SResourceParams } from '../../utils';

const
    chart = "strimzi-kafka-operator",
    repo = "https://strimzi.io/charts/",
    version = "0.21.1";

export class CRDs extends pulumi.ComponentResource {
    public readonly chart: k8s.helm.v3.Chart;

    constructor(opts: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:k8s:StrimziCRDs", "strimzi-crds", {}, opts);

        this.chart = new k8s.helm.v3.Chart("strimzi-crds", {
            chart,
            version,
            fetchOpts: { repo },
            transformations: [
                includeK8SResourceParams({kind: "CustomResourceDefinition"})
            ]
        }, { parent: this });
    }
}

interface OperatorArgs {
    /**
     * Namespace where to install strimzi operator
     */
    namespace: pulumi.Input<string>;

    /**
     * Whether to install operator CustomResourceDefinitions (default true).
     * CustomResourceDefinitions associated with this operator can be also installed separately.
     */
    installCRDs?: boolean;

    /**
     * List of namespaces to watch for strimzi custom resources
     */
    watchNamespaces?: pulumi.Input<pulumi.Input<string>[]>;

    /**
     * Whether to watch any namespace for strimzi custom resources
     */
    watchAnyNamespace?: pulumi.Input<boolean>;
}

export class Operator extends pulumi.ComponentResource {
    public readonly name: pulumi.Output<string>;
    public readonly namespace: pulumi.Output<string>;
 
    public readonly chart: k8s.helm.v3.Chart;

    constructor(name: string, args: OperatorArgs, opts: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:k8s:StrimziKafkaOperator", name, {}, opts);

        let {
            namespace,
            installCRDs = true,
            watchNamespaces,
            watchAnyNamespace,
        } = args || {};

        let values = {
            ...(watchNamespaces && {watchNamespaces}),
            ...(watchAnyNamespace && {watchAnyNamespace}),
        };

        this.chart = new k8s.helm.v3.Chart(name, {
            chart,
            version,
            fetchOpts: { repo },
            namespace,
            values,
            transformations: [
                ...(installCRDs ? [] : [removeK8SResourceParams({kind: "CustomResourceDefinition"})]),

                // fix duplicate cluster role bindings
                ((obj: any) => {
                    if (obj.kind == "ClusterRoleBinding" && obj.metadata.namespace) {
                        obj.metadata.name = `${obj.metadata.name}-${obj.metadata.namespace}`;
                    }
                })
            ]
        }, { parent: this });
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
        type?: pulumi.Input<"ephemeral" | "jbod" | "persistent-claim">;
        class?: pulumi.Input<string>;
        size?: pulumi.Input<string>;
        sizeLimit?: pulumi.Input<string>;
        deleteClaim?: pulumi.Input<boolean>;
        volumes?: pulumi.Input<pulumi.Input<{
            id: pulumi.Input<number>;
            type: pulumi.Input<"ephemeral" | "persistent-claim">; 
            class?: pulumi.Input<string>;
            size: pulumi.Input<string>;
            sizeLimit?: pulumi.Input<string>;
            deleteClaim?: pulumi.Input<boolean>;
        }>[]>;
    };
    zookeeper?: {
        replicas?: pulumi.Input<number>;
        storage: {
            type?: pulumi.Input<"ephemeral" | "persistent-claim">;
            replicas?: pulumi.Input<number>;
            class?: pulumi.Input<string>;
            size?: pulumi.Input<string>;
            sizeLimit?: pulumi.Input<string>;
            deleteClaim?: pulumi.Input<boolean>;
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
                type: "persistent-claim",
                size: "1Gi",
                class: "standard",
                deleteClaim: true
            },
        } = args;

        let {
            replicas: zkReplicas = pulumi.output(replicas).apply(replicas => replicas > 2 ? 3 : 1 || 1),
            storage: zkStorage = {
                type: "persistent-claim",
                size: "1Gi",
                class: "standard",
                deleteClaim: true
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

        const kafkaInfo = kafka.body.apply(value => {
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
        }, { parent: this, provider: this.provider, ...opts })
    }

    newUser(name: string, args: Omit<KafkaUserArgs, 'namespace' | 'clusterName'>, opts?: pulumi.ComponentResourceOptions): KafkaUser {
        return new KafkaUser(name, {
            ...args,
            authenticationType: this.authenticationType,
            authorizationType: this.authorizationType,
            namespace: this.namespace,
            clusterName: this.name
        }, { parent: this, provider: this.provider, ...opts});
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
        }, { parent: this, provider: this.provider, ...opts });

        return connect;
    }

    createClientProperties(user?: KafkaUser): pulumi.Output<string> {
        return createClientProperties(this, user);
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
    public readonly topicName: pulumi.Output<string>;

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
                ...(topicName && {name: topicName}),
                labels: {
                    "strimzi.io/cluster": clusterName
                }
            },
            spec
        }, { parent: this, deleteBeforeReplace: true }), "kafkatopics", isReady, opts.provider);

        this.customResource = topic;
        this.name = topic.metadata.name;
        this.topicName = pulumi.output(topicName || topic.metadata.name);
        this.namespace = topic.metadata.namespace;
    }
}

interface KafkaUserAcl {
    resource: pulumi.Input<{
        type: pulumi.Input<"topic" | "group" | "cluster" | "transactionalId">;
        name?: pulumi.Input<string>;
        patternType?: pulumi.Input<"literal" | "prefix">;
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
        }, { parent: this, deleteBeforeReplace: true }), "kafkausers", isReady, opts.provider);

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
    image?: pulumi.Input<string>;
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
            image,
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
            ...(image && {image}),
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

interface KafkaConnectImageArgs extends PartialBy<docker.ImageArgs, 'build'> {
    /**
     * List of confluent plugins to install in the image
     */
    confluentPlugins: pulumi.Input<pulumi.Input<{name: string, version: string}>[]>;

    /**
     * Strimzi kafka image to use, by default quay.io/strimzi/kafka:0.21.1-kafka-2.7.0
     */
    strimziKakfaImage?: pulumi.Input<string>;

    /**
     * Confluent platform kafka image to use, by default confluentinc/cp-kafka-connect:6.1.0,
     * which includes kafka-2.7.0
     */
    cpKafkaImage?: pulumi.Input<string>;

    /**
     * Extra files to copy into docker image
     */
    extraContent?: pulumi.Input<pulumi.Input<{name: string, content: pulumi.Input<string>}>[]>;
}

export class KafkaConnectImage extends pulumi.ComponentResource {
    public readonly image: docker.Image;

    constructor(name: string, args: KafkaConnectImageArgs, opts?: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:k8s:KafkaConnectImage", name, {}, opts);

        let {
            confluentPlugins = [],
            strimziKakfaImage = "quay.io/strimzi/kafka:0.21.1-kafka-2.7.0",
            cpKafkaImage = "confluentinc/cp-kafka-connect:6.1.0",
            extraContent = []
        } = args;

        const context = pulumi.
            all([confluentPlugins, strimziKakfaImage, cpKafkaImage, extraContent]).
            apply(async ([confluentPlugins, strimziKakfaImage, cpKafkaImage, extraFiles]) => {
                const javaPath = "/usr/share/java";
                const pluginsPath = "/opt/kafka/plugins";
                const ccompnentPath = "/usr/share/confluent-hub-components";

                const dockerfile = `
FROM ${cpKafkaImage} as cp
${confluentPlugins.map(p => `RUN confluent-hub install --no-prompt confluentinc/${p.name}:${p.version}`).join("\n")}
FROM ${strimziKakfaImage}
USER root:root
COPY --from=cp ${javaPath}/confluent-common ${pluginsPath}/confluent-common
COPY --from=cp ${javaPath}/kafka-serde-tools ${pluginsPath}/kafka-serde-tools
${confluentPlugins.map(p =>
    `COPY --from=cp ${ccompnentPath}/confluentinc-${p.name} ${pluginsPath}/confluentinc-${p.name}`
).join("\n")}
${extraFiles.map(f => `COPY ${path.basename(f.name)} ${f.name}`)}
RUN cd ${pluginsPath} && \\
    for plugin in ${confluentPlugins.map(p => `confluentinc-${p.name}`).join()}; do \\
        cd $plugin; ln -s ../confluent-common; ln -s ../kafka-serde-tools; cd ..; \\
    done
        `;
                return await writeTmpFiles({
                    "Dockerfile": dockerfile,
                    ...fromEntries(extraFiles.map(f => [path.basename(f.name), f.content]))
                });
            });

        this.image = new docker.Image(name, {
            ...args,
            build: { context },
        }, {parent: this});
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

interface ApicurioRegistryOperatorArgs {
    namespace: pulumi.Input<string>;
}

export class ApicurioRegistryOperator extends pulumi.ComponentResource {
    constructor(args: ApicurioRegistryOperatorArgs, opts: WithRequired<pulumi.ComponentResourceOptions, 'provider'>) {
        super("pulumi-extra:k8s:ApicurioRegistryOperator", "apicurio-registry-operator", {}, opts);

        let {
            namespace
        } = args;

        /*new OperatorSubscription("apicurio-registry-operator", {
            namespace,
            channel: "alpha",
            name: "apicurio-registry",
            source: "operatorhubio-catalog"
        }, { parent: this, provider: opts.provider });*/

    }
}

interface ApicurioRegistryArgs {
    namespace: pulumi.Input<string>;
    name?: pulumi.Input<string>;
    bootstrapServers: pulumi.Input<string>;
    scram?: {
        truststoreSecretName: pulumi.Input<string>;
        user: pulumi.Input<string>;
        passwordSecretName: pulumi.Input<string>;
    };
}

function isReady(resource: any) {
    for (const condition of resource?.status?.conditions || []) {
        if (condition.type == "Ready" && condition.status == "True") return true;
    }

    return false;
}

export function createClientProperties(kafka: Kafka, user?: KafkaUser): pulumi.Output<string> {
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