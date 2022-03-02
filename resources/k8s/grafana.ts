import merge from "ts-deepmerge";

import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';

import { WithRequired } from '../util';
import { includeK8SResourceParams, removeK8SResourceParams, waitK8SCustomResourceCondition } from '../../utils';

const
    chart = "grafana-operator",
    repo = "https://charts.bitnami.com/bitnami",
    version = "0.6.0";

/**
 * GrafanaOperatorCRDs provisions grafana operator crds
 */
export class CRDs extends pulumi.ComponentResource {
    public readonly chart: k8s.helm.v3.Chart;

    constructor(opts: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:k8s:GrafanaOperatorCRDs", "grafana-operator-crds", {}, opts);

        this.chart = new k8s.helm.v3.Chart("grafana-operator-crds", {
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
 * OperatorArgs defines Operator arguments
 */
interface OperatorArgs {
    /**
     * Namespace where to install grafana operator
     */
    namespace: pulumi.Input<string>;

    /**
     * Whether to scan all namespace for custom resources
     */
    scanAllNamespaces?: pulumi.Input<boolean>;

    /**
     * List of namespaces to scan for custom resources
     */
    scanNamespaces?: pulumi.Input<pulumi.Input<string>[]>;

    /**
     * Whether to install operator CustomResourceDefinitions (default true).
     * CustomResourceDefinitions associated with this operator can be also installed separately.
     */
    installCRDs?: boolean;

    /**
     * Extra values passed to helm chart that installs grafana operator
     */
    extraValues?: pulumi.Inputs;
}

/**
 * Operator provision grafana operator.
 */
export class Operator extends pulumi.ComponentResource {
    /**
     * Name of namespace where operator was installed
     */
    public readonly namespace: pulumi.Output<string>;
 
    /**
     * Helm chart that installed operator
     */
    public readonly chart: k8s.helm.v3.Chart;

    constructor(name: string, args: OperatorArgs, opts: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:k8s:GrafanaOperator", name, {}, opts);

        let {
            namespace,
            installCRDs = true,
            scanAllNamespaces,
            scanNamespaces,
            extraValues = {}
        } = args;

        let values = merge({
            ...(scanAllNamespaces && {scanAllNamespaces}),
            ...(scanNamespaces && {scanNamespaces}),

            // disable installation of grafana itself
            grafana: { enabled: false }
        }, extraValues);

        this.chart = new k8s.helm.v3.Chart(name, {
            chart,
            version,
            fetchOpts: { repo },
            namespace,
            values,
            transformations: [
                ...(installCRDs ? [] : [removeK8SResourceParams({kind: "CustomResourceDefinition"})])
            ]
        }, { parent: this });

        this.namespace = pulumi.output(namespace);
    }
}

/**
 * GrafanaArgs defines arguments for provisioning Grafana.
 */
interface GrafanaArgs {
    /**
     * Name of grafana instance
     */
    name?: string;
    
    /**
     * Namespace where to install grafana
     */
    namespace: pulumi.Input<string>;

    /**
     * Extra spec to pass to grafana
     */
    extraSpec?: pulumi.Inputs;
}

/**
 * Grafana custom resource, which provisions grafana instance in same namespace.
 * Currently only one Grafana instance can be running in a single namespace.
 */
export class Grafana extends pulumi.ComponentResource {
    public readonly grafana: k8s.apiextensions.CustomResource;

    constructor(args: GrafanaArgs, opts: WithRequired<pulumi.ComponentResourceOptions, 'provider'>) {
        super("pulumi-extra:k8s:Grafana", args.name || "grafana", {}, opts);

        const defaultResourceOptions = { parent: this };

        let {
            name = "grafana",
            namespace,
            extraSpec: extraConfig = {}
        } = args;

        let spec = merge({
            ingress: {
                enabled: false
            },
            config: {
                auth: {
                    disable_signout_menu: true
                },
                "auth.anonymous": {
                    enabled: true
                },
                log: {
                    level: "warn",
                    mode: "console"
                },
                security: {
                    admin_password: "secret",
                    admin_user: "root"
                }
            },
            dashboardLabelSelector: [{
                matchExpressions: [{
                    key: "app",
                    operator: "In",
                    values: ["grafana"]
                }]
            }]
        }, extraConfig);

        // only one grafana per namespace is currently supported
        const grafana = new k8s.apiextensions.CustomResource(name, {
            apiVersion: "integreatly.org/v1alpha1",
            kind: "Grafana",
            metadata: {
                namespace,
                name: "grafana"
            },
            spec
        }, {...defaultResourceOptions, deleteBeforeReplace: true});

        this.grafana = waitK8SCustomResourceCondition(grafana, resource => {
            return resource?.status?.message == "success";
        }, opts.provider);
    }

    newDashboard(name: string, args: Omit<GrafanaDashboardArgs, 'namespace'>, opts?: pulumi.ComponentResourceOptions): GrafanaDashboard {
        return new GrafanaDashboard(name, {
            ...args,
            namespace: this.grafana.metadata.namespace
        }, { parent: this, ...opts });
    }

    newDataSource(name: string, args: Omit<GrafanaDataSourceArgs, 'namespace'>, opts?: pulumi.ComponentResourceOptions): GrafanaDataSource {
        return new GrafanaDataSource(name, {
            ...args,
            namespace: this.grafana.metadata.namespace
        }, { parent: this, ...opts });
    }
}

/**
 * GrafanaDashboard defines arguments for provisioning GrafanaDashboard.
 */
interface GrafanaDashboardArgs {
    /**
     * Name of grafana dashboard including json suffix (ex. my-dashboard.json)
     */
    name?: pulumi.Input<string>;

    /**
     * Namespace where to install grafana dashboard
     */
    namespace: pulumi.Input<string>;

    /**
     * Grafana dashboard json as object
     */
    dashboard?: pulumi.Input<any>;

    /**
     * Grafana dashboard json as string
     */
    dashboardString?: pulumi.Input<string>;

    /**
     * Name of custom folder for grafana
     */
    customFolderName?: pulumi.Input<string>;
}

/**
 * GrafanaDashboard custom resource, which provisions grafana dashboard
 * for grafana instance running in same namespace
 */
export class GrafanaDashboard extends pulumi.ComponentResource {
    /**
     * Provisioned GrafanaDashboard custom resource
     */
    public readonly dashboard: k8s.apiextensions.CustomResource;

    constructor(name: string, args: GrafanaDashboardArgs, opts?: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:k8s:GrafanaDashboard", name, {}, opts);

        const defaultResourceOptions = { parent: this };

        let {
            name: dashboardName = pulumi.interpolate `${name}.json`,
            namespace,
            dashboard,
            dashboardString,
            customFolderName
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
                name: dashboardName,
                ...(dashboard && {
                    json: pulumi.output(dashboard).apply(dashboard => JSON.stringify(dashboard))
                }),
                ...(dashboardString && {json: dashboardString}),
                ...(customFolderName && {customFolderName})
            }
        }, { ...defaultResourceOptions,  deleteBeforeReplace: true });
    }
}

/**
 * Single data source configuration, for description what different
 * options mean, take a look here: https://grafana.com/docs/grafana/latest/administration/provisioning/#data-sources
 */
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

/**
 * GrafanaDataSourceArgs defines arguments for provisioning GrafanaDataSource
 */
interface GrafanaDataSourceArgs {
    /**
     * Name of grafana datasource (default name-<random_suffix>)
     */
    name?: pulumi.Input<string>;

    /**
     * Name of namespace where to deploy grafana datasources
     */
    namespace: pulumi.Input<string>;

    /**
     * List of datasources to deploy
     */
    datasources: pulumi.Input<pulumi.Input<GrafanaDataSourceEntry>[]>;
}

/**
 * GrafanaDatasource custom resource, which provisions grafana datasource
 * for grafana instance running in same namespace.
 */
export class GrafanaDataSource extends pulumi.ComponentResource {
    /**
     * Provisioned GrafanaDatasource custom resource
     */
    public readonly dashboard: k8s.apiextensions.CustomResource;

    constructor(name: string, args: GrafanaDataSourceArgs, opts?: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:k8s:GrafanaDataSource", name, {}, opts);

        const defaultResourceOptions = { parent: this };

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
        }, { ...defaultResourceOptions, deleteBeforeReplace: true });
    }
}
