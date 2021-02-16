import * as path from 'path';
import * as fs from 'fs';

import * as deepmerge from 'deepmerge';
import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import * as random from '@pulumi/random';

import { OperatorSubscription } from './olm';
import { waitK8SCustomResourceCondition, waitK8SServiceIP } from '../../utils';

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
    extraConfig?: object;
}

export class Kafka extends pulumi.ComponentResource {
    public readonly kafka: k8s.apiextensions.CustomResource;

    constructor(name: string, args: KafkaArgs, opts?: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:k8s:Kafka", name, {}, opts);

        let {
            namespace,
            replicas = 1,
            zkReplicas = (args.replicas && args.replicas > 2 ? 3 : 1) || 1,
            inSyncReplicas = (args.replicas && args.replicas > 2 ? 2 : 1) || 1,
            replicationFactor = (args.replicas && args.replicas > 2 ? 3 : 1) || 1,
            extraConfig = {}
        } = args;

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
                "storage": {
                    "type": "ephemeral"
                }
            },
            "zookeeper": {
                "replicas": zkReplicas,
                "storage": {
                    "type": "ephemeral"
                }
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

        this.kafka = waitK8SCustomResourceCondition(kafka, "kafkas", resource => {
            for (const condition of resource?.status?.conditions || []) {
                if (condition.type == "Ready" && condition.status == "True") return true;
            }

            return false;
        }, opts.provider)
    }
}
