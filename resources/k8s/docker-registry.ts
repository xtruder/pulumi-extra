import { Htpasswd, HtpasswdAlgorithm } from 'pulumi-htpasswd';

import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import * as random from '@pulumi/random';
import deepMerge from 'ts-deepmerge';

import { Certificate } from '../tls';

export interface DockerRegistryUser {
    username: pulumi.Input<string>;
    password: pulumi.Input<string>;
}

export interface DockerRegistryArgs {
    namespace: pulumi.Input<string>;
    port?: pulumi.Output<number>;
    enablePersistence?: pulumi.Input<boolean>;
    storageSize?: pulumi.Input<string>;
    storageClass?: pulumi.Input<string>;
    extraConfig?: Record<string, pulumi.Input<any>>;
    credentials?: pulumi.Input<DockerRegistryUser>[];
    tlsSecretName?: pulumi.Input<string>;
    cert?: Certificate;
}

export class DockerRegistry extends pulumi.ComponentResource {
    public readonly name: pulumi.Output<string>;
    public readonly namespace: pulumi.Output<string>;
    public readonly port: pulumi.Output<number>;
    public readonly tlsSecretName: pulumi.Output<string>;

    public readonly chart: k8s.helm.v3.Chart;

    constructor(name: string, args: DockerRegistryArgs, opts?: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:k8s:DockerRegistry", name, {}, opts);

        const {
            namespace,
            port = 5000,
            enablePersistence = false,
            storageSize = "1Gi",
            storageClass,
            credentials,
            cert,
            tlsSecretName,
            extraConfig = {}
        } = args;

        let htpasswd: pulumi.Output<Htpasswd> | undefined;
        if (credentials) {
            // create htpasswd
            htpasswd = pulumi.all(credentials).
                apply(credentials => new Htpasswd(`${name}-htpasswd`, {
                    algorithm: HtpasswdAlgorithm.Bcrypt,
                    entries: credentials
                }, { parent: this }));
        }

        let haSharedSecret = new random.RandomPassword(`${name}-secret`, {
            length: 20,
            special: false
        }, { parent: this }).result;

        if (cert && !tlsSecretName) {
            const certSecret = new k8s.core.v1.Secret(`${name}-cert`, {
                metadata: { namespace },
                type: "kubernetes.io/tls",
                stringData: {
                    "tls.crt": cert.getCertificate(),
                    "tls.key": cert.getPrivateKey(),
                    "ca.crt": cert.getCaCertPem()
                }
            }, { parent: this });

            this.tlsSecretName = certSecret.metadata.name;
        }

        const values = deepMerge({
            ...(this.tlsSecretName && {tlsSecretName: this.tlsSecretName}),
            service: {
                port
            },
            secrets: {
                haSharedSecret,
                ...(htpasswd && {
                    htpasswd: htpasswd.result
                })
            },
            persistence: {
                enabled: enablePersistence,
                size: storageSize,
                storageClass
            }
        }, extraConfig);

        // deploy chart
        this.chart = new k8s.helm.v3.Chart(name, {
            chart: "docker-registry",
            fetchOpts: {
                repo: "https://helm.twun.io"
            },
            namespace,
            values
        }, { parent: this });

        this.name = pulumi.interpolate `${name}-docker-registry`;
        this.namespace = pulumi.output(namespace);
        this.port = pulumi.output(port);
    }
}