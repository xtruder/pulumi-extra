import * as deepmerge from 'deepmerge';

import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';

import { OperatorSubscription } from './olm';
import { waitK8SCustomResourceCondition } from '../../utils';

interface GrafanaOperatorArgs {
    namespace: pulumi.Input<string>;
}

export class GrafanaOperator extends pulumi.ComponentResource {
    constructor(name: string, args: GrafanaOperatorArgs, opts?: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:k8s:GrafanaOperator", name, {}, opts);

        const defaultResourceOptions: pulumi.ResourceOptions = { parent: this };

        let {
            namespace
        } = args;

        new OperatorSubscription(name, {
            namespace,
            channel: "alpha",
            operatorName: "grafana-operator",
            source: "operatorhubio-catalog"
        }, defaultResourceOptions);
    }
}

interface GrafanaArgs {
    namespace: pulumi.Input<string>;
    values?: object;
}

export class Grafana extends pulumi.ComponentResource {
    public readonly grafana: k8s.apiextensions.CustomResource;

    constructor(args: GrafanaArgs, opts?: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:k8s:Grafana", "grafana", {}, opts);

        let {
            namespace,
            values = {}
        } = args;

        const overwriteMerge = (_destinationArray, sourceArray) => sourceArray;

        let spec = deepmerge({
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
        }, values, { arrayMerge: overwriteMerge });

        // only one grafana per namespace is currently supported
        const grafana = new k8s.apiextensions.CustomResource("grafana", {
            apiVersion: "integreatly.org/v1alpha1",
            kind: "Grafana",
            metadata: {
                namespace,
                name: "grafana"
            },
            spec
        }, {parent: this, deleteBeforeReplace: true});

        this.grafana = waitK8SCustomResourceCondition(grafana, "grafanas", resource => {
            return resource?.status?.message == "success";
        }, opts.provider)
    }

    newDashboard(name: string, args: Omit<GrafanaDashboardArgs, 'namespace'>): GrafanaDashboard {
        return new GrafanaDashboard(name, {
            ...args,
            namespace: this.grafana.metadata.namespace
        }, { parent: this });
    }

    newDataSource(name: string, args: Omit<GrafanaDataSourceArgs, 'namespace'>): GrafanaDataSource {
        return new GrafanaDataSource(name, {
            ...args,
            namespace: this.grafana.metadata.namespace
        }, { parent: this });
    }
}

interface GrafanaDashboardArgs {
    name?: pulumi.Input<string>;
    namespace: pulumi.Input<string>;
    dashboard: object;
}

export class GrafanaDashboard extends pulumi.ComponentResource {
    public readonly dashboard: k8s.apiextensions.CustomResource;

    constructor(name: string, args: GrafanaDashboardArgs, opts?: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:k8s:GrafanaDashboard", name, {}, opts);

        let {
            name: dashboardName = pulumi.interpolate `${name}.json`,
            namespace,
            dashboard
        } = args;

        this.dashboard = new k8s.apiextensions.CustomResource(name, {
            apiVersion: "integreatly.org/v1alpha1",
            kind: "GrafanaDashboard",
            metadata: {
                namespace,
                name,
                labels: {
                    app: "grafana"
                }
            },
            spec: {
                json: JSON.stringify(dashboard),
                name: dashboardName
            }
        }, {parent: this, deleteBeforeReplace: true});
    }
}

interface GrafanaDataSourceEntry {
    name: pulumi.Input<string>;
    type: pulumi.Input<string>;
    version?: pulumi.Input<number>;
    url?: pulumi.Input<string>;
    access?: pulumi.Input<"proxy">;
    editable?: pulumi.Input<boolean>;
    isDefault?: pulumi.Input<boolean>;
    database?: pulumi.Input<string>;
    user?: pulumi.Input<string>;
    jsonData?: pulumi.Input<object>;
    secureJsonData?: pulumi.Input<object>;
}

interface GrafanaDataSourceArgs {
    name?: pulumi.Input<string>;
    namespace: pulumi.Input<string>;
    datasources: pulumi.Input<GrafanaDataSourceEntry[]>;
}

export class GrafanaDataSource extends pulumi.ComponentResource {
    public readonly dashboard: k8s.apiextensions.CustomResource;

    constructor(name: string, args: GrafanaDataSourceArgs, opts?: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:k8s:GrafanaDataSource", name, {}, opts);

        let {
            name: datasourceName = pulumi.interpolate `${name}.json`,
            namespace,
            datasources
        } = args;

        this.dashboard = new k8s.apiextensions.CustomResource(name, {
            apiVersion: "integreatly.org/v1alpha1",
            kind: "GrafanaDataSource",
            metadata: {
                namespace,
                name,
                labels: {
                    app: "grafana"
                }
            },
            spec: {
                datasources,
                name: datasourceName
            }
        }, {parent: this, deleteBeforeReplace: true});
    }
}
