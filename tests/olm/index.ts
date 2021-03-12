import * as k8s from '@pulumi/kubernetes';

import { olm, waitK8SCustomResourceCondition } from '../..';
import { check } from '../utils';

const provider = new k8s.Provider("k8s");

const operator = new olm.Operator("olm", {}, { provider });

operator.chart.getResource("v1/Namespace", "olm").
    apply(ns => ns.metadata.name).
    apply(check("olm", operator));

operator.chart.getResource("apps/v1/Deployment", "olm", "olm-operator").
    apply(deployment => deployment.metadata.name).
    apply(check("olm-operator", operator));

const namespace = new k8s.core.v1.Namespace("grafana", {}, { deleteBeforeReplace: true });

const operatorGroup = new olm.OperatorGroup("grafana-group", {
    namespace: namespace.metadata.name,
    targetNamespaces: [namespace.metadata.name]
}, {provider});

const operatorSubscription = new olm.Subscription("grafana-operator", {
    namespace: namespace.metadata.name,
    channel: "alpha",
    name: "grafana-operator",
    source: "operatorhubio-catalog"
}, { dependsOn: [operatorGroup], provider });

const grafanaInstance = new k8s.apiextensions.CustomResource("grafana", {
    apiVersion: "integreatly.org/v1alpha1",
    kind: "Grafana",
    metadata: {
        namespace: namespace.metadata.name,
    },
    spec: {
        "ingress": {
            "enabled": true
        },
        "config": {
            "auth": {
                "disable_signout_menu": true
            },
            "auth.anonymous": {
                "enabled": true
            },
            "log": {
                "level": "warn",
                "mode": "console"
            },
            "security": {
                "admin_password": "secret",
                "admin_user": "root"
            }
        },
        "dashboardLabelSelector": [
            {
                "matchExpressions": [
                    {
                        "key": "app",
                        "operator": "In",
                        "values": [
                            "grafana"
                        ]
                    }
                ]
            }
        ]
    }
}, { dependsOn: [operatorSubscription], provider });

const wgetJob = new k8s.batch.v1.Job("wget-grafana", {
    metadata: {
        namespace: namespace.metadata.name
    },
    spec: {
        template: {
            spec: {
                restartPolicy: "Never",
                containers: [{
                    name: "caller",
                    image: "busybox",
                    command: ["sh", "-c", "wget http://grafana-service:3000"]
                }]
            }
        },
    }
}, {
    dependsOn: [
        waitK8SCustomResourceCondition(grafanaInstance, "grafanas", resource => {
            return resource.status.message == "success";
        }, provider)
    ],
    provider
});

wgetJob.status.succeeded.apply(check(1, wgetJob));