import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

import { check } from '../../utils';

import { knative } from '../../..';

const provider = new k8s.Provider("k8s");

const knativeResource = new knative.Knative({
    serving: {
        defaultDomain: false
    }
}, { provider });

export const namespace = new k8s.core.v1.Namespace("knative-testing", {}, { provider }).metadata.name;

const ksvc = knative.waitReady(new k8s.apiextensions.CustomResource("helloworld-go", {
    apiVersion: "serving.knative.dev/v1",
    kind: "Service",
    metadata: {
        name: "helloworld-go",
        namespace
    },
    spec: {
        template: {
            spec: {
                containers: [
                    {
                        image: "gcr.io/knative-samples/helloworld-go",
                        env: [
                            {
                                name: "TARGET",
                                value: "Go Sample v1"
                            }
                        ]
                    }
                ]
            }
        }
    }
}, { provider, dependsOn: [knativeResource]}), provider);

const ksvcHost = ksvc.body.apply(ksvc => (ksvc?.status?.url as string || "").replace("http://", ""));

const wgetJob = new k8s.batch.v1.Job("wget-grafana", {
    metadata: { namespace },
    spec: {
        template: {
            spec: {
                restartPolicy: "Never",
                containers: [{
                    name: "caller",
                    image: "busybox",
                    command: ["sh", "-c",
                        (pulumi.interpolate `wget --header "Host: ${ksvcHost}" http://kourier.kourier-system`)
                    ]
                }]
            }
        },
    }
}, {
    dependsOn: [ksvc],
    provider
});

wgetJob.status.succeeded.apply(check(1, wgetJob));