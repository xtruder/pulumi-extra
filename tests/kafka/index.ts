import * as k8s from '@pulumi/kubernetes';

import { OperatorLifecycleManager, StrimziKafkaOperator, Kafka, KafkaConnect, KafkaConnector } from '../..';

const provider = new k8s.Provider("k8s");

const olm = new OperatorLifecycleManager("olm", {}, { provider });

const operator = new StrimziKafkaOperator({}, { provider, dependsOn: [olm] });

export const namespace = new k8s.core.v1.Namespace("kafka", {}, { provider }).metadata.name;

const kafka = new Kafka("kafka", {
    namespace
}, { provider, dependsOn: [operator] });

export const clusterCaCert = kafka.clusterCACert;
export const clusterIP = kafka.bootstrapClusterIP;

const connect = new KafkaConnect("kafka-connect", {
    namespace,
    bootstrapServers: kafka.bootstrapServers,
    trustedCASecretName: kafka.clusterCACertSecretName,
    config: {
        "group.id": "connect-cluster",
        "offset.storage.topic": "connect-cluster-offsets",
        "config.storage.topic": "connect-cluster-configs",
        "status.storage.topic": "connect-cluster-status",
        "config.storage.replication.factor": 1,
        "offset.storage.replication.factor": 1,
        "status.storage.replication.factor": 1,
    }
}, { parent: kafka, provider });

connect.newConnector("kafka-connector", {
    class: "org.apache.kafka.connect.file.FileStreamSourceConnector",
    taskMax: 2,
    config: {
        file: "/opt/kafka/LICENSE",
        topic: "my-topic"
    }
});