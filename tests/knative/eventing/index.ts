import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

import { check } from '../../utils';

import { knative } from '../../..';

const provider = new k8s.Provider("k8s");

// provision knative with eventing enabled
const knativeResource = new knative.Knative({
    eventing: {
        enable: true,
    }
}, { provider });

export const namespace = new k8s.core.v1.Namespace("knative-eventing-test", {}, { provider }).metadata.name;

const broker = knative.waitReady(new k8s.apiextensions.CustomResource("broker", {
    apiVersion: "eventing.knative.dev/v1",
    kind: "Broker",
    metadata: {
        name: "default",
        namespace
    }
}, { dependsOn: [knativeResource]}), provider);

const helloDisplaySvc = knative.waitReady(new k8s.apiextensions.CustomResource("hello-display-svc", {
    apiVersion: "serving.knative.dev/v1",
    kind: "Service",
    metadata: {
        name: "hello-display",
        namespace
    },
    spec: {
        template: {
            spec: {
                containers: [{
                    image: "gcr.io/knative-releases/knative.dev/eventing-contrib/cmd/event_display",
                }]
            }
        }
    }
}, { provider, dependsOn: [knativeResource]}), provider);

const goodbyeDisplaySvc = knative.waitReady(new k8s.apiextensions.CustomResource("goodbye-display-svc", {
    apiVersion: "serving.knative.dev/v1",
    kind: "Service",
    metadata: {
        name: "goodbye-display",
        namespace
    },
    spec: {
        template: {
            spec: {
                containers: [{
                    image: "gcr.io/knative-releases/knative.dev/eventing-contrib/cmd/event_display",
                }]
            }
        }
    }
}, { provider, dependsOn: [knativeResource]}), provider);

const helloDisplayTrigger = knative.waitReady(new k8s.apiextensions.CustomResource("hello-display-trigger", {
    apiVersion: "eventing.knative.dev/v1",
    kind: "Trigger",
    metadata: {
        name: "hello-display",
        namespace
    },
    spec: {
        broker: "default",
        filter: {
            attributes: {type: "greeting"}
        },
        subscriber: {
            ref: {
                apiVersion: "serving.knative.dev/v1",
                kind: "Service",
                name: "hello-display"
            }
        }
    }
}, { dependsOn: [broker]}), provider);

const goodbyeDisplayTrigger = knative.waitReady(new k8s.apiextensions.CustomResource("goodbye-display-trigger", {
    apiVersion: "eventing.knative.dev/v1",
    kind: "Trigger",
    metadata: {
        name: "goodbye-display",
        namespace
    },
    spec: {
        broker: "default",
        filter: {
            attributes: {source: "sendoff"}
        },
        subscriber: {
            ref: {
                apiVersion: "serving.knative.dev/v1",
                kind: "Service",
                name: "hello-display"
            }
        }
    }
}, { dependsOn: [broker] }), provider);
