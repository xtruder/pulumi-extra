# Kafka test

## Description

Kafka tests bootstraps:

- ssl sasl secured kafka and zookeeper cluster using operator lifecycle manager
- kafka connect cluster
- kafka topic
- kafka users
- job running util completion, consuming topic generated using kafka connector

## Operations

Note: you need to have kafka 2.7 tools installed locally

- Listing topics

```
kafka-topics --list \
    --bootstrap-server $(pulumi stack output --show-secrets  bootstrapServers) \
    --command-config <(pulumi stack output --show-secrets adminProperties)
```

- Describe consumer groups

```
kafka-consumer-groups --group my-group --describe \
    --bootstrap-server $(pulumi stack output --show-secrets  bootstrapServers) \
    --command-config <(pulumi stack output --show-secrets userProperties) 
```

- Reset consumer group topic offsets

```
kafka-consumer-groups --reset-offsets --to-earliest --execute \
    --group my-group --topic $(pulumi stack output --show-secrets topicName) \
    --bootstrap-server $(pulumi stack output --show-secrets bootstrapServers) \
    --command-config <(pulumi stack output --show-secrets userProperties)
```

- Consume using consumer groups

```
kafka-console-consumer --topic $(pulumi stack output --show-secrets topicName) --group my-group \
    --bootstrap-server $(pulumi stack output --show-secrets  bootstrapServers) \
    --consumer.config <(pulumi stack output --show-secrets userProperties)
```

- Consume directly from partitions

```
kafka-console-consumer --partition 0 --offset earliest --topic $(pulumi stack output --show-secrets topicName) \
    --bootstrap-server $(pulumi stack output --show-secrets  bootstrapServers) \
    --consumer.config <(pulumi stack output --show-secrets userProperties)  
```

- Consume avro messages

```
kafka-avro-console-consumer \
    --topic $(pulumi stack output --show-secrets topicName) --group my-group \
    --bootstrap-server $(pulumi stack output --show-secrets  bootstrapServers) \
    --consumer.config <(pulumi stack output --show-secrets userProperties) \
    --property schema.registry.url=$(pulumi stack output registryUrl)
```