import * as path from 'path';
import * as fs from 'fs';

import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import * as random from '@pulumi/random';

import { filesDir } from './util';
import { OperatorSubscription } from './olm';
import { waitK8SCustomResourceCondition, waitK8SServiceIP } from '../../utils';

interface PostgresOperatorArgs {
    namespace: pulumi.Input<string>;
}

export class PostgresOperator extends pulumi.ComponentResource {
    constructor(name: string, args: PostgresOperatorArgs, opts?: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:k8s:PostgresOperator", name, {}, opts);

        const defaultResourceOptions: pulumi.ResourceOptions = { parent:this };

        let {
            namespace
        } = args;

        const pgBackrestRepoConfig = new k8s.core.v1.Secret("pgo-backrest-repo-config", {
            metadata: {
                name: "pgo-backrest-repo-config",
                namespace
            },
            stringData: {
                config: `Host *
                StrictHostKeyChecking no
                IdentityFile /tmp/id_ed25519
                Port 2022
                User pgbackrest`,
                "sshd_config": fs.readFileSync(path.join(filesDir, "postgres-operator", "sshd_config"), 'utf8'),
                "aws-s3-ca.crt": fs.readFileSync(path.join(filesDir, "postgres-operator", "aws-s3-ca.crt"), 'utf-8')
            }
        });

        new OperatorSubscription(name, {
            namespace,
            channel: "stable",
            operatorName: "postgresql",
            source: "operatorhubio-catalog"
        }, {...defaultResourceOptions, dependsOn: [ pgBackrestRepoConfig ]});
    }
}

interface PostgresClusterArgs {
    namespace: pulumi.Input<string>;
    clusterName?: pulumi.Input<string>;
    storageClass?: pulumi.Input<string>;
    backupStorageClass?: pulumi.Input<string>;
    username?: pulumi.Input<string>;
    dbname?: pulumi.Input<string>;
    storageSize?: pulumi.Input<string>;
    backupStorageSize?: pulumi.Input<string>;
    replicas?: {
        count?: pulumi.Input<number>;
    },
    tls?: {
        cert?: pulumi.Input<string>;
        key?: pulumi.Input<string>;
        ca?: pulumi.Input<string>;
        certSecretName?: pulumi.Input<string>;
        caSecretName?: pulumi.Input<string>;
    }
}

export class PostgresCluster extends pulumi.ComponentResource {
    public readonly cluster: k8s.apiextensions.CustomResource;
    public readonly replicas: k8s.apiextensions.CustomResource[] = [];

    public readonly clusterIP: pulumi.Output<string>;
    public readonly postgresPassword: pulumi.Output<string>;
    public readonly username: pulumi.Output<string>;
    public readonly password: pulumi.Output<string>;
    public readonly dbname: pulumi.Output<string>;

    constructor(name: string, args: PostgresClusterArgs, opts?: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:k8s:PostgresCluster", name, {}, opts);

        const defaultResourceOptions: pulumi.ResourceOptions = { parent:this };

        let {
            clusterName,
            namespace,
            storageClass = "default",
            backupStorageClass = "default",
            username = "user",
            dbname = "userdb",
            storageSize = "300M",
            backupStorageSize = "400M",
            tls = {},
            replicas = {}
        } = args;

        let {
            cert,
            key,
            ca,
            certSecretName,
            caSecretName
        } = tls;

        const postgresPassword = new random.RandomPassword(`${name}-postgres-pw`, {
            length: 16,
            special: false,
        }, defaultResourceOptions);

        this.postgresPassword = pulumi.secret(postgresPassword.result);

        const postgresSecret = new k8s.core.v1.Secret(`${name}-postgres`, {
            metadata: { namespace },
            stringData: {
                username: "postgres",
                password: postgresPassword.result
            },
            type: "Opaque"
        }, defaultResourceOptions);

        const primaryUserPassword = new random.RandomPassword(`${name}-primary-user-pw`, {
            length: 16,
            special: false,
        }, defaultResourceOptions);

        const primaryUserSecret = new k8s.core.v1.Secret(`${name}-primary-user`, {
            metadata: { namespace },
            stringData: {
                username: "primaryuser",
                password: primaryUserPassword.result
            },
            type: "Opaque"
        }, defaultResourceOptions);

        const userPassword = new random.RandomPassword(`${name}-user-pw`, {
            length: 16,
            special: false,
        }, defaultResourceOptions);

        this.username = pulumi.output(username);
        this.password = pulumi.secret(userPassword.result);
        this.dbname = pulumi.output(dbname);

        const userSecret = new k8s.core.v1.Secret(`${name}-user`, {
            metadata: { namespace },
            stringData: {
                username,
                password: userPassword.result
            },
            type: "Opaque"
        }, defaultResourceOptions);

        if (ca) {
            const postgresCaSecret = new k8s.core.v1.Secret(`${name}-ca`, {
                metadata: { namespace },
                stringData: {
                    "ca.crt": ca
                },
                type: "Opaque"
            }, defaultResourceOptions);

            caSecretName = postgresCaSecret.metadata.name
        }

        if (cert && key) {
            const postgresTlsKeypair = new k8s.core.v1.Secret(`${name}-tls-key`, {
                metadata: { namespace },
                stringData: {
                    "tls.crt": cert,
                    "tls.key": key
                },
                type: "tls"
            }, defaultResourceOptions);

            certSecretName = postgresTlsKeypair.metadata.name;
        }

        if (!clusterName) {
            const genClusterSuffix = new random.RandomString("random", {
                length: 8,
                special: false,
                upper: false
            }, defaultResourceOptions);

            clusterName = genClusterSuffix.result.apply(v => `${name}-${v}`);
        }

        const replicaStorage = {
            "accessmode": "ReadWriteOnce",
            "matchLabels": "",
            "name": "",
            "size": storageSize,
            "storageclass": storageClass,
            "storagetype": "dynamic",
            "supplementalgroups": ""
        };

        const userLabels = {
            "crunchy-postgres-exporter": "false",
            "pg-pod-anti-affinity": "",
            "pgo-version": "4.5.1",
            "pgouser": "pgoadmin",
            "pgo-backrest": "true"
        };

        let spec = {
            "name": clusterName,
            "namespace": namespace,
            "ArchiveStorage": {
                "accessmode": "",
                "matchLabels": "",
                "name": "",
                "size": "",
                "storageclass": "",
                "storagetype": "",
                "supplementalgroups": ""
            },
            "BackrestStorage": {
                "accessmode": "ReadWriteOnce",
                "matchLabels": "",
                "name": "",
                "size": backupStorageSize,
                "storageclass": backupStorageClass,
                "storagetype": "dynamic",
                "supplementalgroups": ""
            },
            "PrimaryStorage": {
                "accessmode": "ReadWriteOnce",
                "matchLabels": "",
                "name": "on2today",
                "size": storageSize,
                "storageclass": storageClass,
                "storagetype": "dynamic",
                "supplementalgroups": ""
            },
            "ReplicaStorage": replicaStorage,
            "backrestResources": {},
            "ccpimage": "crunchy-postgres-ha",
            "ccpimagetag": "centos7-12.5-4.5.1",
            "clustername": clusterName,
            "customconfig": "",
            "database": dbname,
            "exporterport": "9187",
            "pgBouncer": {
                "replicas": 0,
                "resources": {},
            },
            "pgbadgerport": "10000",
            "podPodAntiAffinity": {
                "default": "preferred",
                "pgBackRest": "preferred",
                "pgBouncer": "preferred"
            },
            "policies": "",
            "port": "5432",
            "primarysecretname": primaryUserSecret.metadata.name,
            "replicas": "0",
            "rootsecretname": postgresSecret.metadata.name,
            "secretfrom": "",
            "shutdown": false,
            "standby": false,
            "status": "",
            "syncReplication": null,
            "tablespaceMounts": {},
            "tls": {},
            "user": username,
            "userlabels": userLabels,
            "usersecretname": userSecret.metadata.name,
            "nodeAffinity": "preferred"
        };

        if (caSecretName && certSecretName) {
            spec.tls = {
                caSecret: caSecretName,
                tlsSecret: certSecretName
            };
        }

        const pgCluster = new k8s.apiextensions.CustomResource(name, {
            apiVersion: "crunchydata.com/v1",
            kind: "Pgcluster",
            metadata: {
                annotations: {
                    "current-primary": clusterName 
                },
                labels: {
                    "autofail": "true",
                    "crunchy-pgbadger": "false",
                    "crunchy-pgha-scope": clusterName,
                    "crunchy-postgres-exporter": "false",
                    "current-primary": clusterName,
                    "deployment-name": clusterName,
                    "name": clusterName,
                    "pg-cluste": clusterName,
                    "pg-pod-anti-affinity": "",
                    "pgo-backrest": "true",
                    "pgo-version": "4.5.1",
                    "pgouser": "pgoadmin",
                    "primary": "true"
                },
                name: clusterName,
                namespace
            },
            spec
        }, defaultResourceOptions);

        this.cluster = waitK8SCustomResourceCondition(pgCluster, "pgclusters", resource => {
            return resource?.status?.state == "pgcluster Initialized";
        }, opts.provider);

        this.clusterIP = waitK8SServiceIP(namespace, clusterName, opts.provider);

        let {
            count: replicaCount = 0
        } = replicas;

        for (let i=0; i<replicaCount; i++) {
            let replicaName = pulumi.interpolate `${clusterName}-rpl-${i}`;

            let replica = new k8s.apiextensions.CustomResource(`${name}-rpl-${i}`, {
                apiVersion: "crunchydata.com/v1",
                kind: "Pgreplica",
                metadata: {
                    labels: {
                        name: replicaName,
                        pgcluster: clusterName,
                        pgouser: "pgoadmin"
                    },
                    name: replicaName,
                    namespace
                },
                spec: {
                    clustername: clusterName,
                    name: replicaName,
                    namespace,
                    replicastorage: replicaStorage,
                    tolerations: [],
                    userlabels: userLabels
                }
            }, {...defaultResourceOptions, dependsOn: [ this.cluster ], deleteBeforeReplace: true});

            this.replicas.push(
                waitK8SCustomResourceCondition(replica, "pgreplicas", resource => {
                    return resource?.status?.state == "pgreplica Processed";
                }, opts.provider)
            );
        };
    }
}