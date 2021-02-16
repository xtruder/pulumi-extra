import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import * as random from '@pulumi/random';
import * as postgresql from '@pulumi/postgresql';

import { OperatorLifecycleManager, OperatorGroup, PostgresOperator, PostgresCluster, RootSigningCertificate } from '../..';

const ca = new RootSigningCertificate("ca", {});

const provider = new k8s.Provider("k8s");

const olm = new OperatorLifecycleManager("olm", {}, { provider });

export const namespace = new k8s.core.v1.Namespace("postgres", {}, { provider }).metadata.name;

const operatorGroup = new OperatorGroup("postgres-group", {
    namespace: namespace,
    targetNamespaces: [namespace]
}, {dependsOn: [olm], provider});

const genClusterSuffix = new random.RandomString("random", {
    length: 8,
    special: false,
    upper: false
});

const clusterName = genClusterSuffix.result.apply(v => `postgres-${v}`);

const cert = ca.newCert("postgres", {
    commonName: clusterName,
    dnsNames: [
        clusterName,
        pulumi.interpolate `${clusterName}.${namespace}`,
        pulumi.interpolate `${clusterName}-pgbouncer`,
        pulumi.interpolate `${clusterName}-pgbouncer.${namespace}`,
    ]
})

const operator = new PostgresOperator("postgres-operator", {
    namespace
}, { dependsOn: [ operatorGroup ], provider });

const pgCluster = new PostgresCluster("postgres-cluster", {
    clusterName,
    namespace,
    storageClass: "local-path",
    backupStorageClass: "local-path",
    replicas: {
        count: 1
    },
    tls: {
        ca: ca.getCertificate(),
        cert: cert.getCertificate(),
        key: cert.getPrivateKey()
    }
}, { dependsOn: [ operator ], provider });

const psqlProvider = new postgresql.Provider("postgresql", {
    host: pgCluster.clusterIP,
    port: 5432,
    username: "postgres",
    password: pgCluster.postgresPassword,
    sslmode: "require"
}, { dependsOn: [pgCluster]});

const db = new postgresql.Database("testdb", {}, { provider: psqlProvider });

new postgresql.Grant("testdb-grant-user-database-connect-temp", {
    database: db.name,
    role: pgCluster.username,
    objectType: "database",
    privileges: ["CONNECT", "TEMPORARY"]
}, { provider: psqlProvider });

new postgresql.Grant(`testdb-grant-user-schema-all`, {
    database: db.name,
    role: pgCluster.username,
    schema: "public",
    objectType: "schema" as string,
    privileges: ["CREATE", "USAGE"],
}, { provider: psqlProvider });

for (const [objectType, privileges] of [
    ["table", ["UPDATE", "REFERENCES", "TRUNCATE", "SELECT", "DELETE", "TRIGGER", "INSERT"]],
    ["sequence", ["UPDATE", "SELECT", "USAGE"]],
    ["function", ["EXECUTE"]],
]) {
    new postgresql.DefaultPrivileges(`testdb-default-grant-user-${objectType}-all`, {
        database: db.name,
        schema: "public",
        owner: "postgres",
        role: pgCluster.username,
        objectType: objectType as string,
        privileges: privileges as string[]
    }, {provider: psqlProvider})
}

new postgresql.Grant("testdb-revoke-public", {
    database: db.name,
    role: "public",
    schema: "public",
    objectType: "schema",
    privileges: []
}, { provider: psqlProvider });

export const testdb = db.name;
export const clusterIP = pgCluster.clusterIP;
export const postgresPassword = pgCluster.postgresPassword;
export const username = pgCluster.username;
export const password = pgCluster.password;
export const dbname = pgCluster.dbname;