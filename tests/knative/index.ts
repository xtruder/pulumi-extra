import * as k8s from '@pulumi/kubernetes';
import { knative } from '../../';

const provider = new k8s.Provider("k8s");

const knativeResource = new knative.Knative({
    eventing: {
        enable: true
    }
}, { provider });

export const namespace = new k8s.core.v1.Namespace("knative-testing", {}, { provider }).metadata.name;

new k8s.apiextensions.CustomResource("helloworld-go", {
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
}, { provider, dependsOn: [knativeResource]});