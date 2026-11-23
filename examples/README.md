# Order Service – Design

Overview of the **order service**. See the [API](api/openapi.yaml) and the [sequence diagram](sequence.puml).

## Sequence (embedded file)

![Order flow](sequence.puml)

## Inline diagram

```plantuml
@startuml
Alice -> Bob: Hello
Bob --> Alice: Hi
@enduml
```

## Flow (Mermaid)

ok this is cool

```mermaid
flowchart LR
  Cart --> Checkout --> Payment
```

See also [the full flow](flow.mmd) and the [class model](classes.puml).

## Decisions and other cool things

| # | Decision | Status |
|---|----------|--------|
| 1 | Orders are immutable after payment | accepted |

## More Mermaid types

```mermaid
sequenceDiagram
  Alice->>Bob: Hi
  Bob-->>Alice: Hello
```

```mermaid
classDiagram
  class Order { +id +total() }
  Order --> Customer
```

```mermaid
stateDiagram-v2
  [*] --> Draft
  Draft --> Paid
```
