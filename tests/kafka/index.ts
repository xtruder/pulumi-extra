import * as k8s from '@pulumi/kubernetes';

import { OperatorLifecycleManager, StrimziKafkaOperator, Kafka } from '../..';
import { createKafkaClientProperties } from '../../resources';

const provider = new k8s.Provider("k8s");

const olm = new OperatorLifecycleManager("olm", {}, { provider });

const operator = new StrimziKafkaOperator({}, { provider, dependsOn: [olm] });

export const namespace = new k8s.core.v1.Namespace("kafka", {}, { provider }).metadata.name;

const kafka = new Kafka("kafka-cluster", {
    namespace,
    authenticationType: "scram-sha-512",
    authorizationType: "simple"
}, { provider, dependsOn: [operator] });

export const clusterName = kafka.name;
export const clusterCaCert = kafka.clusterCACert;
export const bootstrapServers = kafka.bootstrapServers;
export const adminName = kafka.admin.name;
export const adminPassword = kafka.admin.password;
export const adminProperties = createKafkaClientProperties(kafka, kafka.admin);

const myTopic = kafka.newTopic("my-topic");

const user = kafka.newUser("my-user", {
    acls: [{
        resource: {
            type: "topic",
            name: myTopic.name,
            patternType: "literal"
        },
        operation: "All",
        host: "*"
    }, {
        resource: {
            type: "group",
            name: "my-group",
            patternType: "literal"
        },
        operation: "All",
        host: "*"
    }]
});

export const topicName = myTopic.name;
export const userName = user.name;
export const userPassword = user.password;
export const userProperties = createKafkaClientProperties(kafka, user);

const connect = kafka.newConnect("kafka-connect", {
    config: {
        "config.storage.replication.factor": 1,
        "offset.storage.replication.factor": 1,
        "status.storage.replication.factor": 1,
    },
    user: {
        acls: [{
            resource: {
                type: "topic",
                name: myTopic.name,
                patternType: "literal"
            },
            operation: "All",
            host: "*"
        }]
    }
}, {dependsOn: [myTopic]});

const connector = connect.newConnector("my-connector", {
    class: "org.apache.kafka.connect.file.FileStreamSourceConnector",
    taskMax: 2,
    config: {
        file: "/opt/kafka/LICENSE",
        topic: myTopic.name
    }
}, { dependsOn: [myTopic] });

const consumeJobUserPropertiesSecret = new k8s.core.v1.Secret("kafka-consume-job-admin-properties", {
    metadata: { namespace },
    stringData: {
        "client.properties": userProperties
    }
});

const kafkaConsumerJob = new k8s.batch.v1.Job("kafka-consume-job", {
    metadata: {
        namespace: namespace
    },
    spec: {
        template: {
            spec: {
                restartPolicy: "OnFailure",
                containers: [{
                    name: "consumer",
                    image: "quay.io/strimzi/kafka:0.21.1-kafka-2.7.0",
                    command: [
                        "/opt/kafka/bin/kafka-console-consumer.sh",
                        "--bootstrap-server",
                        kafka.bootstrapServers,
                        "--consumer.config", "/run/kafka/config/client.properties",
                        "--partition", "0",
                        "--offset", "earliest",
                        "--topic", myTopic.name,
                        "--timeout-ms", "30000"
                    ],
                    volumeMounts: [{
                        mountPath: "/run/kafka/config",
                        name: "client-config"
                    }]
                }],
                volumes: [{
                    name: "client-config",
                    secret: {
                        secretName: consumeJobUserPropertiesSecret.metadata.name
                    }
                }]
            },
        },
    }
}, { dependsOn: [ connector ], provider });
