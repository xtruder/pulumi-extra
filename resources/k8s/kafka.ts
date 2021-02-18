import * as path from 'path';
import * as fs from 'fs';

import * as deepmerge from 'deepmerge';
import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import * as random from '@pulumi/random';

import { OperatorSubscription } from './olm';
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

interface KafkaArgs {
    namespace: pulumi.Input<string>;
    replicas?: pulumi.Input<number>;
    zkReplicas?: pulumi.Input<number>;
    inSyncReplicas?: pulumi.Input<number>;
    replicationFactor?: pulumi.Input<number>;
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
    public readonly bootstrapClusterIP: pulumi.Output<string>;
    public readonly clusterCACert: pulumi.Output<string>;
    public readonly clusterCACertSecretName: pulumi.Output<string>;
    public readonly bootstrapServers: pulumi.Output<string[]>;
    public readonly customResource: k8s.apiextensions.CustomResource;

    constructor(name: string, args: KafkaArgs, opts?: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:k8s:Kafka", name, {}, opts);

        let {
            namespace,
            replicas = 1,
            inSyncReplicas = (args.replicas && args.replicas > 2 ? 2 : 1) || 1,
            replicationFactor = (args.replicas && args.replicas > 2 ? 3 : 1) || 1,
            extraConfig = {},
            storage = {
                type: "ephemeral"
            },
        } = args;

        let {
            replicas: zkReplicas = replicas > 2 ? 3 : 1 || 1,
            storage: zkStorage = {
                type: "ephemeral"
            }
        } = args.zookeeper || {};

        const overwriteMerge = (_destinationArray, sourceArray) => sourceArray;

        let spec = deepmerge({
            "kafka": {
                "version": "2.7.0",
                "replicas": replicas,
                "listeners": [
                    {
                        "name": "plain",
                        "port": 9092,
                        "type": "internal",
                        "tls": false
                    },
                    {
                        "name": "tls",
                        "port": 9093,
                        "type": "internal",
                        "tls": true
                    }
                ],
                "config": {
                    "offsets.topic.replication.factor": replicationFactor,
                    "transaction.state.log.replication.factor": replicationFactor,
                    "transaction.state.log.min.isr": inSyncReplicas,
                    "log.message.format.version": "2.7",
                    "inter.broker.protocol.version": "2.7"
                },
                storage
            },
            "zookeeper": {
                "replicas": zkReplicas,
                "storage": zkStorage
            },
            "entityOperator": {
                "topicOperator": {},
                "userOperator": {}
            }
        }, extraConfig, {arrayMerge: overwriteMerge});

        // only one grafana per namespace is currently supported
        const kafka = new k8s.apiextensions.CustomResource(name, {
            apiVersion: "kafka.strimzi.io/v1beta1",
            kind: "Kafka",
            metadata: {
                namespace,
            },
            spec
        }, { parent: this });

        this.customResource = waitK8SCustomResourceCondition(kafka, "kafkas", isReady, opts.provider);
        this.name = kafka.metadata.name;

        this.bootstrapClusterIP = waitK8SService(
            namespace,
            this.name.apply(name => `${name}-kafka-bootstrap`),
            opts.provider, this.customResource
        ).apply(service => service?.spec.clusterIP);

        this.clusterCACert = waitK8SSecret(
            namespace,
            this.name.apply(name => `${name}-cluster-ca-cert`),
            opts.provider, this.customResource
        ).apply(secret => secret && Buffer.from(secret.data["ca.crt"], 'base64').toString());

        this.clusterCACertSecretName = this.name.apply(name => `${name}-cluster-ca-cert`);
        this.bootstrapServers = this.name.apply(name => [`${name}-kafka-bootstrap:9093`]);
    }
}

interface KafkaConnectArgs {
    namespace: pulumi.Input<string>;
    version?: pulumi.Input<string>;
    replicas?: pulumi.Input<number>;
    bootstrapServers: pulumi.Input<pulumi.Input<string>[]>;
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
    private readonly providedName: string;

    constructor(name: string, args: KafkaConnectArgs, opts?: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:k8s:KafkaConnect", name, {}, opts);

        this.provider = opts.provider;
        this.providedName = name;

        let {
            namespace,
            version = "2.7.0",
            replicas = 1,
            bootstrapServers,
            trustedCASecretName,
            useConntectorResource = true,
            config,
            extraSpec: extraConfig = {}
        } = args;

        const overwriteMerge = (_destinationArray, sourceArray) => sourceArray;

        let spec = deepmerge({
            version,
            replicas,
            bootstrapServers: pulumi.output(bootstrapServers).apply(servers => servers.join(",")),
            tls: trustedCASecretName ? {
                trustedCertificates: [{
                    secretName: trustedCASecretName,
                    certificate: "ca.crt"
                }]
            } : {},
            config
        }, extraConfig, {arrayMerge: overwriteMerge});

        const connect = new k8s.apiextensions.CustomResource(name, {
            apiVersion: "kafka.strimzi.io/v1beta1",
            kind: "KafkaConnect",
            metadata: {
                namespace,
                annotations: {
                    "strimzi.io/use-connector-resources": useConntectorResource ? "true" : undefined
                }
            },
            spec
        }, { parent: this });

        this.customResource = waitK8SCustomResourceCondition(connect, "kafkaconnects", isReady, opts.provider);
        this.namespace = pulumi.output(namespace);
        this.name = this.customResource.metadata.name;
    }

    newConnector(name: string, args: Omit<KafkaConnectorArgs, 'namespace' | 'clusterName'>) {
        return new KafkaConnector(name, {
            ...args,
            namespace: this.namespace,
            clusterName: this.name
        }, { parent: this, provider: this.provider });
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

    constructor(name: string, args: KafkaConnectorArgs, opts?: pulumi.ComponentResourceOptions) {
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

function isReady(resource) {
    for (const condition of resource?.status?.conditions || []) {
        if (condition.type == "Ready" && condition.status == "True") return true;
    }

    return false;
}