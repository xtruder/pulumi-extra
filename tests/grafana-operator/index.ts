import * as k8s from '@pulumi/kubernetes';
import { tls, grafanaOperator } from '../../';

// const ca = new RootSigningCertificate("ca", {});

const provider = new k8s.Provider("k8s");

export const namespace = new k8s.core.v1.Namespace("grafana", {}, { provider }).metadata.name;

const grafanaOperatorCRDs = new grafanaOperator.CRDs({ provider });

const operator = new grafanaOperator.Operator("grafana-operator", { namespace }, { provider });

// const postgresOperator = new PostgresOperator({
//     namespace
// }, { dependsOn: [ operatorGroup ], provider });

// const pgCluster = new PostgresCluster("postgres-cluster", {
//     clusterName: "postgres",
//     namespace,
//     storageClass: "local-path",
//     backupStorageClass: "local-path",
// }, { dependsOn: [ postgresOperator ], provider });

const grafana = new grafanaOperator.Grafana({
    namespace
}, { dependsOn: [grafanaOperatorCRDs], provider });

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

// grafana.newDataSource("example-datasource", {
//     datasources: [{
//         name: "Postgres",
//         type: "postgres",
//         url: "postgres:5432",
//         database: pgCluster.dbname,
//         user: pgCluster.username,
//         secureJsonData: {
//             password: pgCluster.password
//         },
//         jsonData: {
//             sslmode: "disable",
//             timescaledb: false,
//             postgresVersion: 1200
//         }
//     }]
// });
