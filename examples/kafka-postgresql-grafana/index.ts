import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

import { postgresOperator, apicurioRegistry, tls, grafanaOperator, strimzi } from '../..';

const provider = new k8s.Provider("k8s");

const namespace = new k8s.core.v1.Namespace("kafka", {}, { provider }).metadata.name;

const kafkaOperator = new strimzi.Operator("strimzi-operator", { namespace }, { provider });
const apicurioRegistryOperator = new apicurioRegistry.Operator({ namespace }, { provider });
const psqlOperatorInstance = new postgresOperator.Operator("postgresql-operator", { namespace, }, { provider });
const grafanaOperatorInstance = new grafanaOperator.Operator("grafana-operator", { namespace }, { provider });

const ca = new tls.RootSigningCertificate("ca");

const dbName = "kafka2";

const pgCluster = new postgresOperator.Postgresql("postgresql-cluster", {
    namespace,

    postgresql: {
        version: "12"
    },
    numberOfInstances: 1,

    // provider ca for certificate generation
    ca,

    // create kafka database with kafka user as owner
    preparedDatabases: {
        [dbName]: {
            defaultUsers: true,
            extensions: {
                timescaledb: "data"
            },
            schemas: {
                data: {
                    defaultUsers: true,
                    defaultRoles: false
                }
            }
        }
    }
}, { provider, dependsOn: [psqlOperatorInstance] });

// extract credentials for kafka user
const pgCredentials = pgCluster.roleCredentials.apply(creds => creds[`${dbName}-owner-user`]);

// create new Grafana instance
const grafana = new grafanaOperator.Grafana({
    namespace
}, { provider, dependsOn: [grafanaOperatorInstance] });

// create new postgresql datasource
grafana.newDataSource("postgres", {
    datasources: [{
        name: "Postgres",
        type: "postgres",
        url: pulumi.interpolate `${pgCluster.clusterHost}:5432`,
        database: dbName,
        user: pgCredentials.username,
        secureJsonData: {
            password: pgCredentials.password
        },
        jsonData: {
            sslmode: "require",
            timescaledb: true,
            postgresVersion: 1200
        }
    }]
});

const kafka = new strimzi.Kafka("kafka-cluster", {
    namespace,
    authenticationType: "scram-sha-512",
    authorizationType: "simple"
}, { provider, dependsOn: [kafkaOperator] });

const registry = new apicurioRegistry.Registry("registry", {
    namespace,
    kafka
}, { provider, dependsOn: [apicurioRegistryOperator]})
const registryUrl = pulumi.interpolate `http://${registry.serviceName}.${namespace}.svc:8080/api/ccompat`;

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
    imageName: "registry.kube-system.svc.cluster.local:80/my-kafka:latest",
    confluentPlugins: [
        {name: "kafka-connect-jdbc", version: "10.0.2"},
        {name: "kafka-connect-datagen", version: "0.4.0"}
    ],
    extraContent: [
        // put root ca for postgresql in image, so kafka connect can verify cert
        {
            name: "/root/.postgresql/root.crt",
            content: pgCluster.cert.getCaCertPem()
        }
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

connect.newConnector("kafka-connector-gen-stock-trades", {
    class: "io.confluent.kafka.connect.datagen.DatagenConnector",
    taskMax: 1,
    config: {
        "quickstart": "Stock_Trades",
        "kafka.topic": myTopic.name,
        "key.converter": "org.apache.kafka.connect.storage.StringConverter",
        "value.converter": "io.confluent.connect.avro.AvroConverter",
        "value.converter.schema.registry.url": registryUrl,
        "max.interval": 100,
        "iterations": 10000000
    }
});

connect.newConnector("psql-sink-connector", {
    class: "io.confluent.connect.jdbc.JdbcSinkConnector",
    taskMax: 1,
    config: {
        topics: myTopic.name,
        "auto.create": true,
        "connection.url":  pulumi.interpolate `jdbc:postgresql://${pgCluster.clusterHost}/${dbName}?ssl=true&user=${pgCredentials.username}&password=${pgCredentials.password}`,
        "key.converter": "org.apache.kafka.connect.storage.StringConverter",
        "value.converter": "io.confluent.connect.avro.AvroConverter",
        "value.converter.schema.registry.url": registryUrl,
        "pk.mode": "kafka",
        "transforms": "InsertField",
        "transforms.InsertField.timestamp.field":"ts",
        "transforms.InsertField.type":"org.apache.kafka.connect.transforms.InsertField$Value"
    }
}, { provider });

const adminProperties = kafka.createClientProperties(kafka.admin);
const userProperties = kafka.createClientProperties(user);

const dashboardJSON = require('./dashboard.json');

grafana.newDashboard("trades", {
    dashboardString: myTopic.topicName.apply(name => JSON.stringify(dashboardJSON).replace(new RegExp("<table>", "g"), name)),
    customFolderName: "trading"
});

export { namespace };

export const kafkaClusterName = kafka.name;
export const kafkaClusterCaCert = kafka.clusterCACert;
export const kafkaBootstrapServers = kafka.bootstrapServers;

export const kafkaTopicName = myTopic.name;

export const kafkaAdminName = kafka.admin.name;
export const kafkaAdminPassword = kafka.admin.password;
export const kafkaAdminProperties = adminProperties;

export const kafkaUserName = user.name;
export const kafkaUserPassword = user.password;
export const kafkaUserProperties = userProperties;

export { registryUrl };

export const pgHost = pgCluster.clusterHost;
export const pgUsername = pgCredentials.username;
export const pgPassword = pgCredentials.password;

export { dbName as pgDatabase };