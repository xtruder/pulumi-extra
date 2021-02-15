import * as k8s from '@pulumi/kubernetes';

import { OperatorLifecycleManager, OperatorGroup, RootSigningCertificate, GrafanaOperator, Grafana, PostgresCluster, PostgresOperator } from '../..';

const ca = new RootSigningCertificate("ca", {});

const provider = new k8s.Provider("k8s");

const olm = new OperatorLifecycleManager("olm", {}, { provider });

export const namespace = new k8s.core.v1.Namespace("grafana", {}, { provider }).metadata.name;

const operatorGroup = new OperatorGroup("grafana-group", {
    namespace: namespace,
    targetNamespaces: [namespace]
}, { dependsOn: [olm], provider });

const operator = new GrafanaOperator("grafana-operator", {
    namespace
}, { dependsOn: [operatorGroup], provider });

const postgresOperator = new PostgresOperator("postgres-operator", {
    namespace
}, { dependsOn: [ operatorGroup ], provider });

const pgCluster = new PostgresCluster("postgres-cluster", {
    clusterName: "postgres",
    namespace,
    storageClass: "local-path",
    backupStorageClass: "local-path",
}, { dependsOn: [ postgresOperator ], provider });

const grafana = new Grafana({
    namespace
}, { dependsOn: [operator], provider });

grafana.newDashboard("simple-dashboard", {
    dashboard: {
        "id": null,
        "title": "Simple Dashboard",
        "tags": [],
        "style": "dark",
        "timezone": "browser",
        "editable": true,
        "hideControls": false,
        "graphTooltip": 1,
        "panels": [],
        "time": {
            "from": "now-6h",
            "to": "now"
        },
        "timepicker": {
            "time_options": [],
            "refresh_intervals": []
        },
        "templating": {
            "list": []
        },
        "annotations": {
            "list": []
        },
        "refresh": "5s",
        "schemaVersion": 17,
        "version": 0,
        "links": []
    }
});

grafana.newDataSource("example-datasource", {
    datasources: [{
        name: "Postgres",
        type: "postgres",
        url: "postgres:5432",
        database: pgCluster.dbname,
        user: pgCluster.username,
        secureJsonData: {
            password: pgCluster.password
        },
        jsonData: {
            sslmode: "disable",
            timescaledb: false,
            postgresVersion: 1200
        }
    }]
});
