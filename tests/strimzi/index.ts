import * as k8s from '@pulumi/kubernetes';

import { strimzi } from '../..';

const provider = new k8s.Provider("k8s");

const namespace = new k8s.core.v1.Namespace("kafka", {}, { provider }).metadata.name;

const crds = new strimzi.CRDs({ provider });

new strimzi.Operator("strimzi-kafka-operator", { namespace }, { provider });

const kafka = new strimzi.Kafka("kafka-cluster", {
    namespace,
    authenticationType: "scram-sha-512",
    authorizationType: "simple"
}, { provider, dependsOn: [crds] });

const myTopic = kafka.newTopic("my-topic-new8");

const user = kafka.newUser("my-user", {
    acls: [
        {
            resource: {
                type: "topic",
                name: myTopic.name,
                patternType: "literal"
            },
            operation: "All",
            host: "*"
        },
        {
            resource: {
                type: "group",
                name: "my-group",
                patternType: "literal"
            },
            operation: "All",
            host: "*"
        }
    ]
});

const connectImage = new strimzi.KafkaConnectImage("kafka-connect-image", {
    imageName: "registry.kube-system.svc.cluster.local:80/kafka-test-connect-image",
    confluentPlugins: [
        {name: "kafka-connect-datagen", version: "0.4.0"}
    ]
})

const connect = kafka.newConnect("kafka-connect", {
    config: {
        "config.storage.replication.factor": 1,
        "offset.storage.replication.factor": 1,
        "status.storage.replication.factor": 1,
    },
    user: {
        acls: [
            {
                resource: {
                    type: "topic",
                    name: myTopic.name,
                    patternType: "literal"
                },
                operation: "All",
                host: "*"
            },
            {
                resource: {
                    type: "group",
                    name: "connect-psql-sink-connector",
                    patternType: "prefix"
                },
                operation: "All",
                host: "*"
            },
            {

                resource: {
                    type: "topic",
                    name: "connect-psql-sink-connector",
                    patternType: "prefix"
                },
                operation: "All",
                host: "*"
            },
        ]
    },
    image: connectImage.image.imageName
}, {dependsOn: [myTopic]});

const genDataConnector = connect.newConnector("kafka-connector-gen-stock-trades", {
    class: "io.confluent.kafka.connect.datagen.DatagenConnector",
    taskMax: 1,
    config: {
        "quickstart": "Stock_Trades",
        "kafka.topic": myTopic.name,
        "key.converter": "org.apache.kafka.connect.storage.StringConverter",
        "value.converter": "org.apache.kafka.connect.json.JsonConverter",
        "max.interval": 100,
        "iterations": 600
    }
});

// create client properties file for kafka admin and user
const adminProperties = kafka.createClientProperties(kafka.admin);
const userProperties = kafka.createClientProperties(user);

const consumeJobUserPropertiesSecret = new k8s.core.v1.Secret("kafka-consume-job-admin-properties", {
    metadata: { namespace },
    stringData: {
        "client.properties": userProperties
    }
});

new k8s.batch.v1.Job("kafka-consume-job", {
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
}, { dependsOn: [ genDataConnector ], provider, deleteBeforeReplace: true });

export { namespace };

export const clusterName = kafka.name;
export const clusterCaCert = kafka.clusterCACert;
export const bootstrapServers = kafka.bootstrapServers;

export const topicName = myTopic.name;

export const adminName = kafka.admin.name;
export const adminPassword = kafka.admin.password;
export { adminProperties };

export const userName = user.name;
export const userPassword = user.password;
export { userProperties };