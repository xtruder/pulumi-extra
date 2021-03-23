import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import * as random from '@pulumi/random';
import deepMerge from "ts-deepmerge";

import { base64Decode, WithRequired } from '../util';
import { includeK8SResourceParams, removeK8SResourceParams, waitK8SCustomResourceCondition, CustomResourceWithBody, waitK8SSecret } from '../../utils/k8s';
import { Certificate, RootSigningCertificate } from '../tls';

const
    chart = "postgres-operator",
    repo = "https://opensource.zalando.com/postgres-operator/charts/postgres-operator/",
    version = "1.6.1";

/**
 * Installs zalando postgres operator crds
 */
export class CRDs extends pulumi.ComponentResource {
    /**
     * Chart used for deploying crds
     */
    public readonly chart: k8s.helm.v3.Chart;

    constructor(opts: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:k8s:ZalandoPostgresOperatorCRDs", "zalando-postgres-operator-crds", {}, opts);

        this.chart = new k8s.helm.v3.Chart("zalando-postgres-operator-crds", {
            chart,
            version,
            fetchOpts: { repo },
            transformations: [
                includeK8SResourceParams({kind: "CustomResourceDefinition"})
            ]
        }, { parent: this });
    }
}

/**
 * Arguments for zalando postgresql operator
 */
interface OperatorArgs {
    /**
     * Namespace where to deploy operator
     */
    namespace: pulumi.Input<string>;

    /**
     * Whether to install operator CustomResourceDefinitions (default true).
     * CustomResourceDefinitions associated with this operator can be also installed separately.
     */
    installCRDs?: boolean;

    /**
     * Configuration for wal-g, wal backup
     */
    walg?: {
        /**
         * Wal-g backup schedule in cron format (0 * * * * *)
         */
        backupSchedule?: pulumi.Input<string>;

        /**
         * Number of backups to retain
         */
        backupNumToRetain?: pulumi.Input<number>;

        /**
         * Options to backup wal over ssh
         */
        ssh?: {
            prefix?: pulumi.Input<string>;
            username: pulumi.Input<string>;
            password: pulumi.Input<string>;
            port?: pulumi.Input<number>;
        };

        /**
         * Options to backup wal over s3
         */
        s3?: {
            bucket: pulumi.Input<string>;
            endpoint?: pulumi.Input<string>;
            region?: pulumi.Input<string>;
            accessKeyId: pulumi.Input<string>;
            secretAccessKey: pulumi.Input<string>;
            disableSSE?: pulumi.Input<boolean>;
            forcePathStyle?: pulumi.Input<boolean>;
        };
    };

    /**
     * Configuration for logical backups (sql dumps)
     */
    logicalBackup?: {

        /**
         * Backup schedule in cron format (eg. 00 05 * * *)
         */
        backupSchedule: pulumi.Input<string>;

        /**
         * Options to do logical backups over S3
         */
        s3?: {
            bucket: pulumi.Input<string>;
            endpoint?: pulumi.Input<string>;
            region?: pulumi.Input<string>;
            accessKeyId: pulumi.Input<string>;
            secretAccessKey: pulumi.Input<string>;
            disableSSE?: pulumi.Input<boolean>;
        };
    };

    /**
     * Extra values for operator, for values see here
     * https://github.com/zalando/postgres-operator/blob/v1.6.1/charts/postgres-operator/values.yaml
     */
    extraValues?: pulumi.Inputs;
}

/**
 * Component to deploy zalando postgresql operator
 */
export class Operator extends pulumi.ComponentResource {
    /**
     * Name of the operator deployment
     */
    public readonly name: pulumi.Output<string>;

    /**
     * Name of the namespace where operator is deployed
     */
    public readonly namespace: pulumi.Output<string>;
 
    /**
     * Chart used for deploying operator
     */
    public readonly chart: k8s.helm.v3.Chart;

    constructor(name: string, args: OperatorArgs, opts: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:k8s:ZalandoPostgresqlOperator", name, {}, opts);

        let {
            namespace,
            installCRDs = true,
            walg = {},
            logicalBackup = {
                backupSchedule: "00 05 * * *"
            },
            extraValues = {}
        } = args;

        let podEnvironmentConfigmapData = {
            USE_WALG_BACKUP: "true",

            ...(walg.backupSchedule && {BACKUP_SCHEDULE: walg.backupSchedule.toString()}),
            ...(walg.backupNumToRetain && {BACKUP_NUM_TO_RETAIN: walg.backupNumToRetain.toString()}),

            // walg ssh backups
            ...(walg.ssh && walg?.ssh.prefix && {
                WALG_SSH_PREFIX: walg.ssh.prefix,
                SSH_PORT: walg.ssh.port?.toString() || "22",
            }),

            // walg s3 backups
            ...(walg.s3 && {
                ...(walg.s3.endpoint && {AWS_ENDPOINT: walg.s3.endpoint}),
                ...(walg.s3.region && {AWS_REGION: walg.s3.region}),
                WALG_DISABLE_S3_SSE: walg.s3.disableSSE ? "true" : "false",
                AWS_S3_FORCE_PATH_STYLE: walg.s3.forcePathStyle ? "true" : "false"
            })
        };

        let podEnvironmentSecretData = {
            // walg ssh backups
            ...(walg.ssh && {
                SSH_USERNAME: walg.ssh.username,
                SSH_PASSWORD: walg.ssh.password
            }),

            // walg s3 backups
            ...(walg.s3 && {
                AWS_ACCESS_KEY_ID: walg.s3.accessKeyId,
                AWS_SECRET_ACCESS_KEY: walg.s3.secretAccessKey,
            })
        };

        const podEnvironmentConfigmap = new k8s.core.v1.ConfigMap(`${name}-env`, {
            metadata: {
                namespace
            },
            data: podEnvironmentConfigmapData
        }, { parent: this });

        const podEnvironmentSecret = new k8s.core.v1.Secret(`${name}-env`, {
            metadata: {
                namespace
            },
            stringData: podEnvironmentSecretData
        }, { parent: this });

        let values = deepMerge({
            configKubernetes: {
                pod_environment_configmap: podEnvironmentConfigmap.metadata.name,
                pod_environment_secret: podEnvironmentSecret.metadata.name
            },
            configLogicalBackup: {
                logical_backup_schedule: logicalBackup.backupSchedule,
                ...(logicalBackup.s3 && {
                    logical_backup_s3_bucket: logicalBackup.s3.bucket,
                    ...(logicalBackup.s3.region && {logical_backup_s3_region: logicalBackup.s3.region}),
                    ...(logicalBackup.s3.endpoint && {logical_backup_s3_endpoint: logicalBackup.s3.endpoint}),
                    logical_backup_s3_access_key_id: logicalBackup.s3.accessKeyId,
                    logical_backup_s3_secret_access_key: logicalBackup.s3.secretAccessKey,
                    ...(logicalBackup.s3.disableSSE && {logical_backup_s3_sse: ""}),
                }),
            },
            configAwsOrGcp: {
                ...(walg.s3?.bucket && { wal_s3_bucket: walg.s3?.bucket })
            }
        }, extraValues);

        this.chart = new k8s.helm.v3.Chart(name, {
            chart,
            version,
            fetchOpts: { repo },
            namespace,
            values,
            transformations: [
                ...(installCRDs ? [] : [removeK8SResourceParams({kind: "CustomResourceDefinition"})]),
            ]
        }, { parent: this });
        
        this.name = this.chart.getResource("apps/v1/Deployment", `${name}-postgres-operator`).metadata.name;
        this.namespace = pulumi.output(namespace);
    }
}

type RolePermissions = "inherit" | "superuser" | "login" | "nologin" | "createrole" | "createdb" | "replication" | "bypassrls";

/**
 * Argument for Postgresql resource
 */
interface PostgresqlArgs {
    /**
     * Name of the postgresql cluster (by default name-<random_suffix>)
     */
    clusterName?: pulumi.Input<string>;

    /**
     * Namespace where to deploy postgresql
     */
    namespace: pulumi.Input<string>;

    /**
     * Id of the postgresql team (default: acid)
     */
    teamId?: pulumi.Input<string>;

    /**
     * Postgresql volume options
     */
    volume?: {
        /**
         * Postgresql volume size
         */
        size: pulumi.Input<string>;

        /**
         * Postgresql volume storage class
         */
        storageClass: pulumi.Input<string>;
    };

    /**
     * Number of postgresql instances to run
     */
    numberOfInstances?: pulumi.Input<number>;
    users?: pulumi.Input<Record<string, RolePermissions[]>>;
    databases?: pulumi.Input<Record<string, string>>;
    preparedDatabases?: pulumi.Input<Record<string, {
        defaultUsers?: boolean;
        extensions?: Record<string, string>;
        schemas: Record<string, {
            defaultUsers?: boolean;
            defaultRoles?: boolean;
        }>;
    }>>;
    allowedSourceRanges?: pulumi.Input<pulumi.Input<string[]>>;
    postgresql?: {
        version?: pulumi.Input<string>;
        parameters?: pulumi.Input<Record<string, string>>;
    };
    tls?: {
        secretName: pulumi.Input<string>;
        caSecretName: pulumi.Input<string>;
        caFile?: pulumi.Input<string>;
    };
    ca?: RootSigningCertificate;
    enableLogicalBackup?: pulumi.Input<boolean>;
    logicalBackupSchedule?: pulumi.Input<string>;
    extraConfig?: pulumi.Inputs;
}

export class Postgresql extends pulumi.ComponentResource {
    public readonly name: pulumi.Output<string>;
    public readonly namespace: pulumi.Output<string>;

    /**
     * Postgresql kubernetes cluster hostname
     */
    public readonly clusterHost: pulumi.Output<string>;

    /**
     * Created postgresql custom resource
     */
    public readonly postgresql: CustomResourceWithBody;

    /**
     * Postgresql certificate
     */
    public readonly cert: Certificate;

    /**
     * Created database role credentials
     */
    public readonly roleCredentials: pulumi.Output<Record<string, pulumi.Output<{
        username: string;
        password: string;
    }>>>;
    
    constructor(name: string, args: PostgresqlArgs, opts: WithRequired<pulumi.ComponentResourceOptions, 'provider'>) {
        super("pulumi-extra:k8s:ZalandoPostgresql", name, {}, opts);

        const defaultResourceOptions: pulumi.ResourceOptions = { parent: this };

        let {
            clusterName,
            namespace,
            teamId = "acid",
            volume = {
                size: "1Gi",
                storageClass: "standard"
            },
            numberOfInstances = 1,
            users = {},
            databases,
            preparedDatabases,
            postgresql = {},
            tls,
            ca,
            allowedSourceRanges = ["0.0.0.0/0"],
            enableLogicalBackup = false,
            logicalBackupSchedule,
            extraConfig = {}
        } = args;

        let {
            version = "13",
            parameters = {}
        } = postgresql;

        if (!clusterName) {
            const genClusterSuffix = new random.RandomString("random", {
                length: 8,
                special: false,
                upper: false
            }, defaultResourceOptions);

            clusterName = pulumi.interpolate `${teamId}-${name}-${genClusterSuffix.result}`;
        }

        // if ca has been provided, create a new cert and set secrets
        if (ca) {
            const cert = ca.newCert(`${name}-cert`, {
                commonName: clusterName,
                dnsNames: [
                    clusterName,
                    pulumi.interpolate `${clusterName}.${namespace}`,
                    pulumi.interpolate `${clusterName}.${namespace}.svc`,
                    pulumi.interpolate `${clusterName}.${namespace}.svc.cluster.local`,
                    pulumi.interpolate `${clusterName}-repl`,
                    pulumi.interpolate `${clusterName}-repl.${namespace}`,
                    pulumi.interpolate `${clusterName}-repl.${namespace}.svc`,
                    pulumi.interpolate `${clusterName}-repl.${namespace}.svc.cluster.local`,
                ]
            }, defaultResourceOptions);

            const certSecret = new k8s.core.v1.Secret(`${name}-cert`, {
                type: "tls",
                metadata: {
                    namespace,
                    name: pulumi.interpolate `${clusterName}-cert`
                },
                stringData: {
                    "tls.crt": cert.getCertificate(),
                    "tls.key": cert.getPrivateKey()
                }
            }, defaultResourceOptions);

            const caSecret = new k8s.core.v1.Secret(`${name}-ca-`, {
                type: "Opaque",
                metadata: {
                    namespace,
                    name: pulumi.interpolate `${clusterName}-ca`
                },
                stringData: {
                    "ca.crt": ca.getCertificate()
                }
            }, defaultResourceOptions);

            this.cert = cert;

            tls = {
                secretName: certSecret.metadata.name,
                caSecretName: caSecret.metadata.name,
                caFile: "ca.crt"
            };
        }

        let spec = deepMerge({
            teamId,
            volume,
            numberOfInstances,
            enableShmVolume: true,
            spiloFSGroup: 103,
            users,
            databases,
            preparedDatabases,
            postgresql: {
                version,
                parameters
            },
            allowedSourceRanges,
            tls,
            enableLogicalBackup,
            ...(logicalBackupSchedule && {logicalBackupSchedule}),
        }, extraConfig);

        const psql = new k8s.apiextensions.CustomResource(name, {
            apiVersion: "acid.zalan.do/v1",
            kind: "postgresql",
            metadata: {
                namespace,
                name: clusterName
            },
            spec
        }, {parent: this});

        // wait for postgresql to be running
        this.postgresql = waitK8SCustomResourceCondition(psql, "postgresqls", resource => {
            return resource?.status?.PostgresClusterStatus == "Running";
        }, opts.provider);

        // retrive user secrets
        this.roleCredentials = pulumi.all([users, preparedDatabases]).apply(([users, preparedDatabases]) => {
            let result: Record<string, pulumi.Output<{
                username: string;
                password: string;
            }>> = {};

            let allUsers = ["postgres", ...Object.keys(users)];

            for (const [name, dbOpts] of Object.entries(preparedDatabases || {})) {
                if (dbOpts.defaultUsers) {
                    allUsers.push(`${name}-owner-user`, `${name}-reader-user`, `${name}-writer-user`);
                }

                pulumi.log.info(JSON.stringify(dbOpts));
                for (const [schema, schemaOpts] of Object.entries(dbOpts.schemas)) {
                    if (!schemaOpts.defaultUsers || !schemaOpts.defaultRoles) continue;
                    allUsers.push(`${name}-${schema}-owner-user`, `${name}-${schema}-reader-user`, `${name}-${schema}-writer-user`);
                }
            }

            for (const name of allUsers) {
                result[name] = pulumi.secret(waitK8SSecret(
                    namespace,
                    pulumi.interpolate `${name}.${clusterName}.credentials.postgresql.acid.zalan.do`,
                    opts.provider,
                    psql
                ).apply(secret => ({
                    username: base64Decode(secret?.data?.["username"]),
                    password: base64Decode(secret?.data?.["password"])
                })));
            }

            return result
        });

        this.name = pulumi.output(this.postgresql.metadata.name);
        this.namespace = pulumi.output(this.postgresql.metadata.namespace || namespace);
        this.clusterHost = pulumi.interpolate `${this.name}.${this.namespace}.svc`;
    }
}