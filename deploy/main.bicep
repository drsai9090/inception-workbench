targetScope = 'resourceGroup'

@description('Name of an existing Container Apps managed environment in this resource group.')
param environmentName string

@description('Azure region of the existing managed environment.')
param location string

@minLength(2)
@maxLength(32)
param appName string = 'inception-workbench'

@description('Publicly pullable image repository without a tag or digest, for example ghcr.io/owner/inception-workbench.')
param imageRepository string

@description('Immutable image SHA-256 digest: exactly 64 hexadecimal characters, without the sha256: prefix.')
@minLength(64)
@maxLength(64)
param imageDigest string

@secure()
@minLength(1)
@description('TLS-verified PostgreSQL connection URL using a restricted runtime role in a dedicated synthetic database.')
param databaseUrl string

@secure()
@minLength(32)
param reviewerToken string

@secure()
@minLength(32)
@description('Distinct from reviewerToken. Shared read-only access to the one synthetic sandbox.')
param viewerToken string

resource environment 'Microsoft.App/managedEnvironments@2025-07-01' existing = {
  name: environmentName
}

var origin = 'https://${appName}.${environment.properties.defaultDomain}'

resource app 'Microsoft.App/containerApps@2025-07-01' = {
  name: appName
  location: location
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 4318
        transport: 'http'
      }
      secrets: [
        { name: 'database-url', value: databaseUrl }
        { name: 'reviewer-token', value: reviewerToken }
        { name: 'viewer-token', value: viewerToken }
      ]
    }
    template: {
      containers: [
        {
          name: 'inception'
          image: '${imageRepository}@sha256:${imageDigest}'
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'HOST', value: '0.0.0.0' }
            { name: 'PORT', value: '4318' }
            { name: 'LOCAL_DEMO', value: 'false' }
            { name: 'PUBLIC_ORIGIN', value: origin }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'REVIEWER_TOKEN', secretRef: 'reviewer-token' }
            { name: 'VIEWER_TOKEN', secretRef: 'viewer-token' }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: { path: '/healthz', port: 4318, scheme: 'HTTP' }
              initialDelaySeconds: 5
              periodSeconds: 5
              timeoutSeconds: 5
              failureThreshold: 10
            }
            {
              type: 'Readiness'
              httpGet: { path: '/healthz', port: 4318, scheme: 'HTTP' }
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 3
            }
            {
              type: 'Liveness'
              tcpSocket: { port: 4318 }
              initialDelaySeconds: 10
              periodSeconds: 30
              timeoutSeconds: 5
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
        rules: [
          { name: 'http', http: { metadata: { concurrentRequests: '10' } } }
        ]
      }
    }
  }
}

output url string = origin
output image string = '${imageRepository}@sha256:${imageDigest}'
