import { createApp } from './app.js'
import { loadServerConfig } from './config.js'
import { TelemetryApiClient } from './telemetry/telemetry-api-client.js'
import { createRadiusService } from './radius/create-radius-service.js'
import { createClassificationAuthorizer, createClassificationService } from './classification/create-classification-service.js'
import { ClassifiedRadiusService } from './classification/classified-radius-service.js'

const config = loadServerConfig()
const telemetryClient = new TelemetryApiClient(config.telemetryApi)
const classificationService = createClassificationService(config.classificationDatabase)
await classificationService.initialize()
const radiusService = new ClassifiedRadiusService(createRadiusService(config.radius, config.plantTimeZone), classificationService)
const app = createApp({ telemetryClient, radiusService, classificationService, classificationAuthorizer: createClassificationAuthorizer(config.classificationAuthorization, config.classificationDatabase.enabled) })

app.listen(config.port, config.host, () => {
  console.log(
    `Process Intelligence API listening on http://${config.host}:${config.port}`,
  )
})
