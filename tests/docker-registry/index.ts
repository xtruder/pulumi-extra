import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import * as random from '@pulumi/random';

import { DockerRegistry, RootSigningCertificate } from '../..';

const ca = new RootSigningCertificate("ca", {});

const provider = new k8s.Provider("k8s");

export const namespace = new k8s.core.v1.Namespace("docker-registry", {}, { provider }).metadata.name;

export const username = new random.RandomString("registry-username", {
    length: 8,
    special: false
}).result;

export const password = new random.RandomPassword("registry-password", {
    length: 20,
    special: false
}).result;

const name = "registry-docker-registry";

const cert = ca.newCert("postgres", {
    commonName: name,
    dnsNames: [
        name,
        pulumi.interpolate `${name}.${namespace}`
    ]
});


const registry = new DockerRegistry("registry", {
    namespace,
    cert,
    credentials: [{
        username,
        password
    }]
});

const kanikoSecret = new k8s.core.v1.Secret("kaniko-secret", {
    metadata: { namespace },
    stringData: {
        "config.json": pulumi.
            all([registry.name, registry.namespace, registry.port, username, password]).
            apply(([name, namespace, port, username, password]) => JSON.stringify({
                "auths": {
                    [`https://${name}.${namespace}:${port}`]: {
                        username,
                        password
                    }
                }
            }))
    }
});

const dockerfile = new k8s.core.v1.ConfigMap("dockerfile", {
    metadata: { namespace },
    data: {
        "dockerfile": "FROM busybox"
    }
});

const registryUrl = pulumi.interpolate `${registry.name}.${registry.namespace}:${registry.port}`;

const buildJob = new k8s.batch.v1.Job("kaniko-build-image-job", {
    metadata: {
        namespace
    },
    spec: {
        template: {
            spec: {
                restartPolicy: "OnFailure",
                containers: [{
                    name: "kaniko",
                    image: "gcr.io/kaniko-project/executor:latest",
                    args: [
                        "--dockerfile=/workspace/dockerfile",
                        "--context=dir://workspace",
                        pulumi.interpolate `--registry-certificate=${registryUrl}=/kaniko/.docker/ca.crt`,
                        (pulumi.interpolate `--destination=${registryUrl}/image`)
                    ],
                    volumeMounts: [
                        {
                            name: "docker-config",
                            mountPath: "/kaniko/.docker/config.json",
                            subPath: "config.json"
                        },
                        {
                            name: "ca",
                            mountPath: "/kaniko/.docker/ca.crt",
                            subPath: "ca.crt"
                        },
                        {
                            name: "dockerfile",
                            mountPath: "/workspace/dockerfile",
                            subPath: "dockerfile"
                        },
                    ]
                }],
                volumes: [
                    {
                        name: "docker-config",
                        secret: { secretName: kanikoSecret.metadata.name }
                    },
                    {
                        name: "ca",
                        secret: {
                            secretName: registry.tlsSecretName,
                            items: [{
                                key: "ca.crt",
                                path: "ca.crt"
                            }]
                        }
                    },
                    {
                        name: "dockerfile",
                        configMap: { name: dockerfile.metadata.name }
                    }
                ]
            },
        },
    }
}, { dependsOn: [ registry ], provider });
 
