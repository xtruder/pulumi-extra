import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

import { tls, postgresOperator } from '../..';

const ca = new tls.RootSigningCertificate("ca", {});

const provider = new k8s.Provider("k8s");

const namespace = new k8s.core.v1.Namespace("postgres", {}, { deleteBeforeReplace: true }).metadata.name;

// deploy minio to do backups over S3
const minioService = new k8s.core.v1.Service("minio", {
    metadata: {namespace},
    spec: {
        selector: {app: "minio"},
        ports: [{
            name: "s3",
            port: 9000
        }]
    }
})

new k8s.apps.v1.Deployment("minio", {
    metadata: { namespace },
    spec: {
        selector: {matchLabels: {app: "minio"}},
        template: {
            metadata: {labels: {app: "minio"}},
            spec: {
                containers: [{
                    name: "minio",
                    image: "minio/minio",
                    args: ["server", "/data"],
                    lifecycle: {
                        postStart: {
                            exec: {
                                command: ["/bin/mkdir", "-p", "/data/postgres-backup"]
                            }
                        }
                    },
                    env: [{
                        name: "MINIO_ROOT_USER",
                        value: "user"
                    }, {
                        name: "MINIO_ROOT_PASSWORD",
                        value: "password"
                    }],
                    ports: [{
                        name: "s3",
                        containerPort: 9000,
                    }]
                }],
            }
        }
    }
});

const crds = new postgresOperator.CRDs({ provider });

new postgresOperator.Operator("zalando-postgresql-operator", {
    namespace,

    // enable walg backups to minio every 5 minutes
    walg: {
        backupNumToRetain: 14,
        backupSchedule: "*/5 * * * * *",
        s3: {
            bucket: "postgres-backup",
            accessKeyId: "user",
            secretAccessKey: "password",
            endpoint: pulumi.interpolate `http://${minioService.metadata.name}:9000`,
            disableSSE: true,
            forcePathStyle: true
        },
    },

    // enable logical backups to minio every 5 minutes
    logicalBackup: {
        backupSchedule: "*/5 * * * *",
        s3: {
            bucket: "postgres-backup",
            region: "test",
            accessKeyId: "user",
            secretAccessKey: "password",
            endpoint: pulumi.interpolate `http://${minioService.metadata.name}:9000`,
            disableSSE: true,
        },
    }

}, { provider });

const userDB = "foo";

const psql = new postgresOperator.Postgresql("test-postgresql-cluster", {
    namespace,

    // provider ca for certificate generation
    ca,

    // deploy 1 master and 1 replica
    numberOfInstances: 2,

    // create myuser2 user
    users: {
        myuser2: []
    },

    // create database with myuser2 owner
    databases: {
        [userDB]: "myuser2"
    },
    preparedDatabases: {
        bar: {
            defaultUsers: true,
            schemas: {
                public: {
                    defaultUsers: true,
                    defaultRoles: false
                }
            }
        }
    },

    // enable logical backups
    enableLogicalBackup: true,
    logicalBackupSchedule: "*/5 * * * *",
}, { provider, dependsOn: [crds] });

export const host = psql.clusterHost;
export const adminPassword = psql.roleCredentials.apply(creds => creds.postgres.password);
export const username = psql.roleCredentials.apply(creds => creds.myuser2.username);
export const password = psql.roleCredentials.apply(creds => creds.myuser2.password);
export const db = userDB;
export const caCert = psql.cert.getCaCertPem();