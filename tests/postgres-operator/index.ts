import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import * as random from '@pulumi/random';

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

export const postgresPassword = pgCluster.postgresPassword;
export const username = pgCluster.username;
export const password = pgCluster.password;
export const dbname = pgCluster.dbname;