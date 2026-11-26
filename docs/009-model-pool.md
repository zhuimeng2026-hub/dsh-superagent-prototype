# 009 Model pool

This document describes the model pool this deployment runs on: two upstream
providers reached through one local gateway, how work is spread over them, and
the one request shape that must not be sent to them. It builds on
[006 Deployment](006-deployment.md) and the roles in
[003 Execution](003-execution.md).

The pool is a property of the machine, not of the bundle. The bundle asks for a
provider and a model; this document says which ones exist and why.

## The two providers

| Pool | Reached at | Serves | Credential |
| --- | --- | --- | --- |
| `aikey4k` | `https://aikey4k.mengxa.com:8443` | MiniMax M3 / M3.1 Flash, DeepSeek V4, GLM-5.3, Kimi K3.1 Pro, Qwen3.8, Agnes | its own key, in the credential store as `QINIU_API_KEY` |
| `minimax-cn` | `https://api.minimaxi.com/anthropic` | MiniMax M3 / M3.1 Flash / M2.7 / M2.5 | MiniMax's own key, in the credential store |

Both pools serve the same MiniMax models. They are separate quotas, bought
separately, and they fail separately: one is rate-limited while the other
answers, one is behind a gateway that rewrites requests and the other is not.
That difference is the whole reason for running both.

## The gateway in front

Neither Claude Code nor dsh-superagent talks to a pool directly. Both talk to
**magpie**, a local gateway on `127.0.0.1:3425`, which owns the choice of pool
and the choice of model. It is supervised as a systemd user unit
(`magpie.service`, `Restart=on-failure`), so it comes back on its own.

magpie's catalog lists 43 models across the two pools. The pools are two
providers in its `providers.json`; the model names agents use are routing
groups, not models.

## Routing groups

A group names several models and one way to choose among them. The groups this
deployment uses:

| Group | Members | Routing | Stays | Listed | Used by |
| --- | --- | --- | --- | --- | --- |
| `group/claude` | `aikey4k/MiniMax-M3.1-Flash`, `minimax-cn/MiniMax-M3.1-Flash` | rotate | session | no | Claude Code, all tiers |
| `group/dsh` | `aikey4k/MiniMax-M3`, `minimax-cn/MiniMax-M3` | rotate | session | no | dsh-superagent's Eval role |
| `group/cheap` | `aikey4k/MiniMax-M2.7-highspeed`, `minimax-cn/MiniMax-M2.7-highspeed`, `aikey4k/agnes-3.0-flash` | rotate | session | no | Claude Code's small-fast model |
| `group/alt` | `aikey4k/kimi-k3.1-pro`, `aikey4k/glm-5.3`, `aikey4k/qwen3.8-27b` | order | auto | no | by hand, when the MiniMax pools are busy |
| `group/dsh-free` | `aikey4k/qiniu/conatus-free`, `minimax-cn/MiniMax-M2.7-highspeed`, `aikey4k/MiniMax-M2.7-highspeed` | order | auto | yes | dsh-superagent's Executor role |
| `group/ms-free` | `aikey4k/deepseek-ai/DeepSeek-V4.1-Flash-1017`, `aikey4k/deepseek-ai/DeepSeek-V4-Pro-0813`, `aikey4k/Qwen/Qwen3.5-35B-A3B`, `aikey4k/Qwen/Qwen3.8-Flash-Next`, `aikey4k/ZhipuAI/GLM-5.2`, `aikey4k/MiniMax/MiniMax-M1-80k`, `aikey4k/nex-agi/Nex-N2.5-Pro`, `aikey4k/nex-agi/Nex-N2.5-mini` | rotate | session | no | inside `group/ms` |
| `group/ms` | `group/ms-free`, `minimax-cn/MiniMax-M3` | order | session | no | by hand, for work that should ride the free community compute |

The `aikey4k` pool serves `MiniMax-M3.1-Flash` under the name
`MiniMax-M3.1-Flash-Preview`: magpie rewrites the id on the way out (see
*Model names* below). Every other model keeps its own name on both pools.

`rotate` sends each new request to the next member. `stays session` keeps one
conversation on the member that answered it. Together they mean: a new
conversation starts on the pool that is not busy, and the conversation stays
there for its life. A long Ticket therefore keeps its prompt cache instead of
paying to rebuild it on every turn.

A group also falls through: when a member is out of quota or down, the next
member answers, and the conversation continues from there.

### The ModelScope group

`group/ms` is the free community compute, and it is built in two layers so
that the free quota is used first and something paid answers only when it is
gone:

| Layer | Group | What it is |
| --- | --- | --- |
| inner | `group/ms-free` | eight ModelScope community models on the `aikey4k` pool, routed `rotate` |
| outer | `group/ms` | the inner group first, then `minimax-cn/MiniMax-M3` — routed `order` |

The outer group holds the fallback as a member of its own, because a group
falls through to its members and to nothing else: a provider's own fallback
list is not consulted for a request that named a group. With `order`, the
inner group is asked first and the paid model is asked only when the inner
one cannot answer — when every community model is out of quota or rate
limited. With `rotate` inside, a new conversation starts on the next
community model and the conversation stays on the one that answered it.

Both groups are `listed=no`: their models are offered through the group
alone, so the eight community models do not fill the agents' lists with
near-duplicates of each other.

```
magpie group add ms-free models=aikey4k/deepseek-ai/DeepSeek-V4.1-Flash-1017,… routing=rotate stays=session
magpie group add ms models=group/ms-free,minimax-cn/MiniMax-M3 routing=order stays=session
magpie group set ms-free listed=no context=16384
magpie group set ms listed=no context=16384
```

The community models are free but small. ModelScope's free inference takes
about 18k tokens of input; two of the ten models the channel served —
`mistralai/Mistral-Large-Instruct-2407` and
`opencompass/CompassJudger-1-32B-Instruct` — took only 2k and silently
answered from the truncated prompt, so they are not in the pool. The group
claims `context=16384`, which is what the agents are told, so a conversation
is compacted before the upstream would drop its beginning.

### When the free allowance is gone

The community compute has an allowance of its own, and when it is used up
the channel answers `429 insufficient balance`:

```
aikey4k: Error code: 429 - insufficient balance (request id: 202611241546481369666758268d9d62HQMlHtz)
```

`group/ms` then answers with its second member, the paid
`minimax-cn/MiniMax-M3`, so the work goes on and the bill goes up. The
fallback is the group doing its job, not a fault — but the traffic record
is the only place that shows which member answered:

```sh
# which member of group/ms answered
jq -r 'select(.model=="group/ms") | [.time[11:19], ([.tries[]?|select(.status==200)|.id]|join("+"))] | @tsv' \
  ~/.config/magpie/routing/$(date +%F).jsonl | tail -n 5
```

A `minimax-cn` in that column means the free allowance was gone and the
paid pool answered. The same request asked by name shows the community
model that would have served it:

```sh
curl -s http://127.0.0.1:3425/v1/messages \
  -H 'content-type: application/json' -H 'x-api-key: magpie' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"aikey4k/Qwen/Qwen3.8-Flash-Next","max_tokens":16,
       "messages":[{"role":"user","content":"say OK"}]}'
```

### What each agent is shown

magpie keeps a list of models per agent, and `magpie visible` narrows it. This
deployment shows both agents the six groups and the `aikey4k` pool's models:

```sh
magpie visible claude aikey4k,claude,dsh,cheap,alt,dsh-free,ms
magpie visible dsh aikey4k,claude,dsh,cheap,alt,dsh-free,ms
```

Claude Code's `/model` list then holds 28 entries — six groups and the 22
models of the `aikey4k` pool — and the `llm-pi-ai` block of every DSH profile
patch names the same 28.

A group with `listed=no` keeps its members out of that list: the group is
offered, the models behind it are not. `group/claude`, `group/dsh`,
`group/cheap` and `group/alt` are all `listed=no`, so
`aikey4k/MiniMax-M3.1-Flash`, `aikey4k/MiniMax-M3`,
`aikey4k/MiniMax-M2.7-highspeed`, `aikey4k/agnes-3.0-flash`,
`aikey4k/kimi-k3.1-pro`, `aikey4k/glm-5.3` and `aikey4k/qwen3.8-27b` are
reached through their group and not offered on their own. `group/dsh-free` is
the exception: it is listed, so `aikey4k/qiniu/conatus-free` — a free channel
worth reaching by hand — stays in the list.

A model that is not listed is not gone: it answers when it is asked for by
name, and the gateway's plain `/v1/models` still lists the whole catalog.
Only the per-agent list, `/agent/<agent>/v1/models`, is narrowed.

The `minimax-cn` pool is not in that list, and that is the point: its six
models are the same MiniMax models the `aikey4k` pool serves, so showing both
pools lists every MiniMax model twice. The list names each model once, and the
second pool stays where it belongs — inside the groups, which fall through to
it. Nothing is lost by not showing it: a model that is not shown answers when
it is asked for by name (`minimax-cn/MiniMax-M3.1-Flash` still does), and the
gateway's plain `/v1/models` still lists the whole catalog. Only the per-agent
list, `/agent/<agent>/v1/models`, is narrowed.

To see every model again:

```sh
magpie visible claude all
magpie visible dsh all
```

### Seeing which model is answering

Every row of the list names its model — a group's name says what the group is
made of, a model's row says the model and the pool that serves it:

```
M3.1-Flash 双池 · routing group      group/claude[1m]
M3 双池 · routing group               group/dsh[1m]
Kimi/GLM/Qwen · routing group         group/alt[1m]
MiniMax-M3.1-Flash · aikey4k          aikey4k/MiniMax-M3.1-Flash[1m]
DeepSeek V4 Flash · aikey4k           aikey4k/DeepSeek-V4-Flash[1m]
Kimi K3.1 Pro · aikey4k               aikey4k/kimi-k3.1-pro[1m]
```

A group hides the model behind it, so the name of the group alone does not say
what answered. Two places answer that question: the group's own name, and the
traffic.

A group's **name** is what the agents are shown — Claude Code's `/model` list
and the `llm-pi-ai` block of every DSH profile patch. So the name says what the
group is made of:

```sh
magpie group set claude name="M3.1-Flash 双池" note="…"
```

The id stays `claude`; only the label changes. This deployment's groups are
named after their models for that reason — `M3.1-Flash 双池`,
`M3 双池`, `M2.7极速/agnes`, `Kimi/GLM/Qwen`, `conatus-free/M2.7`.

For the traffic, `magpie usage` is the live answer. It reports what was asked,
which pool took it, and which model served it:

```sh
magpie usage --csv --last 15m | python3 -c '
import csv, sys
for x in csv.DictReader(sys.stdin):
    print(f"{x[\"time\"][11:19]}  asked={x[\"requested_model\"]}  "
          f"pool={x[\"provider\"]}  model={x[\"served_model\"]}  {x[\"status\"]}")'
```

```
14:30:50  asked=group/claude  pool=minimax-cn  model=MiniMax-M3.1-Flash  200
14:30:44  asked=group/claude  pool=minimax-cn  model=MiniMax-M3.1-Flash  200
```

`magpie usage today` is the same thing counted per model, per agent and per
account, with tokens and cost.

Two things to know about when the change takes effect:

- The picker in `~/.claude/settings.json` is rewritten only when magpie next
  writes an agent's model. `magpie claude group/claude` does that; `magpie
  visible` on its own saves the setting and writes nothing.
- A `magpie serve` that was already running keeps the old list until it is
  restarted.

### Reading the traffic

magpie writes every request it routed to
`~/.config/magpie/routing/<date>.jsonl`. Each line names the group asked for,
the pool that served it, and the status. Two checks are worth knowing:

```sh
# which pool served what, today
jq -r 'select(.status==200) | .tries[] | select(.status==200) | .id' \
  ~/.config/magpie/routing/$(date +%F).jsonl | sort | uniq -c

# every failure, with the reason the pool gave
jq -r 'select(.status!=200) | "\(.model): \(.error)"' \
  ~/.config/magpie/routing/$(date +%F).jsonl
```

## How each side is pointed at the pool

### Claude Code

`~/.claude/settings.json` carries the gateway's address and the groups, in the
`env` section:

```json
"ANTHROPIC_BASE_URL": "http://127.0.0.1:3425",
"ANTHROPIC_AUTH_TOKEN": "magpie",
"ANTHROPIC_DEFAULT_OPUS_MODEL": "group/claude[1m]",
"ANTHROPIC_DEFAULT_SONNET_MODEL": "group/claude[1m]",
"ANTHROPIC_DEFAULT_HAIKU_MODEL": "group/cheap",
"ANTHROPIC_SMALL_FAST_MODEL": "group/cheap"
```

magpie writes these itself (`magpie claude group/claude`, `magpie claude haiku
group/cheap`, and so on) and rewrites them whenever its catalog changes. Edit
them with those commands, not by hand, or the next write undoes the change.

magpie writes `CLAUDE_CODE_MODEL_CAPABILITIES` the same way: it names the
models of the pool that offer a reasoning effort, and what effort levels they
offer. A hand edit to that variable takes it away from magpie — magpie then
leaves it alone forever, and its entries go stale as the catalog moves. To
hand it back, delete the variable and run `magpie claude group/claude` again.

The `model` field names a tier, so `--model opus`, `--model sonnet` and
`--model haiku` each land on the group named above. The `[1m]` suffix is the
context window.

### Model names

A model reaches the gateway under one of three names, and they do not mean
the same thing:

| Name | What the gateway does with it |
| --- | --- |
| `group/claude` | Routes over the group's members: both pools, in turn. |
| `minimax-cn/MiniMax-M3.1-Flash` | One pool, one model. No fallback, no rotation. |
| `MiniMax-M3.1-Flash` | The model by its own name, whichever pool serves it. |

A bare name is the one to reach for. It is what the gateway resolves to the
group magpie found for the model (`auto/...`), so it still gets both pools.
A name with a provider in front of it pins the request to that pool — the
group behind it is not consulted, and the other pool is not a fallback.

The `model` field in `settings.json` may name a tier instead (`sonnet[1m]`).
Claude Code resolves the alias to the tier's model before it asks the
gateway, so the gateway never sees the bare word `sonnet`; magpie writes that
form when the main model is the same model as a tier.

magpie's own commands take only the forms it knows: a group, a
`provider/model` id, or a bare model id that magpie itself lists. A bare id
magpie does not list is the user's own — magpie writes only `provider/model`
ids into an agent's config, and leaves a bare one alone.

### dsh-superagent

The profile's `llm-pi-ai` entry carries a `magpie` provider pointing at the
same gateway. It is the only provider in that entry: the pools are reached
through the gateway, never directly.

```yaml
- id: llm-pi-ai
  config:
    providers:
      magpie:
        api: openai-completions
        baseURL: http://127.0.0.1:3425/v1
        apiKeyEnv: MAGPIE_GATEWAY_KEY
        displayName: Magpie
        models:
          - id: group/dsh
            name: M3 双池 · routing group
            ...
```

The gateway's local token is `MAGPIE_GATEWAY_KEY` in `~/.dsh/.credentials.yaml`.
Change the Eval or Executor model in the panel (Settings → Evaluation /
Execution); it applies to new Sessions without a restart.

The two roles sit on different groups: Eval on `group/dsh`, Executor on
`group/dsh-free`. The Executor runs Tickets, which are long and numerous, so
it starts on the free channel and only spends a paid pool when the free one
is out of its limit. `group/dsh-free` is routed `order`, not `rotate`: a
Ticket must not hop between pools halfway through, or it pays to rebuild its
prompt cache.

The profile's `agent-default-model` is the fallback for a Session the panel
did not give a role model. It names `group/dsh` as well, so a Session that
falls back still runs on the gateway rather than on a pool directly.

## The one request shape that fails

**MiniMax's M3.1 Flash refuses to think nothing.** Asked with thinking turned
off, both pools answer:

```
invalid params, model "MiniMax-M3.1-Flash" requires adaptive thinking;
thinking.type="disabled" (including reasoning.effort=none) is not allowed (2013)
```

`MiniMax-M3` (without the `.1`) has no such rule, which is why `group/dsh` is
built from M3 and tolerates every request shape.

The refusal is recoverable, but only if it is recognised. magpie recognises it
by the words `thinking.type="disabled"`, and asks the request again with
thinking left to the model.

### The two gateways that have to agree

Between the caller and the pool's answer there are two gateways, and they have
to agree about the words of that refusal:

| Layer | What it does with the refusal |
| --- | --- |
| `aikey4k` (new-api) | hands the vendor's error back to magpie, masked |
| magpie | reads the error to tell a recoverable refusal from a fatal one |

The mask and the reader did not agree. new-api masks every dotted token that
looks like a domain, and a field name looks like one: `thinking.type` came
back as `***.type` and `reasoning.effort` as `***.effort`. magpie no longer
recognised the refusal, so it passed it straight to the client. A request the
pool would have answered became a hard error.

It is fixed in both layers, because either one alone leaves the other to fail
alone:

- **new-api** keeps the field name. A dotted token used as a key — assigned,
  named by a colon, quoted as a value — is a field name and is left alone;
  every other domain-shaped token is masked as before, and a token ending in a
  top-level domain is a host in every position. The change is
  `relaykit/relayconvert/kitutil/mask.go` on the gateway's machine, where the
  source has no history of its own: the patch is kept beside it, in
  `local-patches/`, and has to be re-applied after a refresh of the source. The
  running container is the image built from it, `new-api:local-20261124`; the
  previous image stays, and going back is one line of `docker-compose.yml`.
- **magpie** reads a masked name as the name it stands for: its detector
  (`internal/gateway/anthropic.go`) takes `***.type` for `thinking.type`, so a
  refusal that arrives masked is asked again all the same. That is a local
  change to the gateway, and the gateway updates itself — it is set to
  announce an update rather than download one (`magpie update auto notify`), so
  a release does not quietly replace the changed binary. A release that is
  taken up needs the change put back; it is kept in `/opt/magpie/local-patches/`.

### The settings that keep it from mattering

**Claude Code** must ask for adaptive thinking rather than saying nothing about
thinking. `alwaysThinkingEnabled: true` in `~/.claude/settings.json` does that:
Claude Code then sends `thinking: {"type":"adaptive"}` on every request, which
both pools accept. With it off, Claude Code omits the field, magpie reads the
absence as thinking off, and the request fails on `group/claude` — whose
members are both M3.1 Flash. Note that `group/dsh` and `group/cheap` are
unaffected either way.

**dsh-superagent** needs no such setting: its `group/dsh` members are M3,
which accepts thinking on, off, or absent.

## The groups magpie finds by itself

When two pools serve a model under the same name, magpie groups them by
itself and calls the group `auto/<model>` — `auto/minimax-m3.1-flash` is the
M3.1 Flash on both pools, `auto/minimax-m3` the M3 on both, and so on.

Those groups are the same members as the hand-made ones: `auto/minimax-m3.1-flash`
is `group/claude`, and `auto/minimax-m3` is `group/dsh`. Only the routing
differs — a found group routes `smart`, a hand-made one as its owner set it.

This deployment does not use them. They are removed:

```sh
magpie group rm auto/minimax-m3.1-flash auto/minimax-m3 auto/minimax-m2.7 \
  auto/minimax-m2.7-highspeed auto/minimax-m2.5 auto/minimax-m2.5-highspeed
```

A removed found group is hidden, not deleted, and comes back with `magpie
group restore <id>`. While they were there, every model of the pool appeared
two or three times in Claude Code's `/model` list and in both DSH profile
patches — once as a group, once as `auto/`, and once per pool.

One thing to know before removing them: a **bare model name is resolved
through a found group**. Asked for `MiniMax-M3.1-Flash`, the gateway answers
with the group magpie found for it, so the request reaches both pools. With
the found groups gone, a bare name reaches one pool — the first that serves
it. The name to reach for instead is the hand-made group: `group/claude`
still covers both pools, and `group/dsh-free` covers the free channel and its
fallbacks.

## One model family, three channels

DeepSeek V4.1 Flash is served on the `aikey4k` pool under three names. They
look like duplicates and are not: each is a separate channel, with its own
upstream model name, its own reasoning levels and its own billing. Asking each
of them is the way to tell them apart:

| Name | Upstream answers | Reasoning levels | Billing |
| --- | --- | --- | --- |
| `aikey4k/DeepSeek-V4.1-Flash` | `self-dploy/DeepSeek-V4.1-Flash` | low, high, max | metered |
| `aikey4k/deepseek-v4.1-flash-1017` | `deepseek-v4.1-flash-1017` | none, low, high, max | metered, no cost field |
| `aikey4k/deepseek-ai/DeepSeek-V4.1-Flash-1017` | ModelScope community compute | — | free allowance |

The third one is the community channel of `group/ms-free`. The first two are
paid channels on the same pool, distinguished by their reasoning levels: the
lower-case id accepts `none`, so it is the one to ask when thinking must be
off.

```sh
for m in DeepSeek-V4.1-Flash deepseek-v4.1-flash-1017 deepseek-ai/DeepSeek-V4.1-Flash-1017; do
  curl -s http://127.0.0.1:3425/v1/messages \
    -H 'content-type: application/json' -H 'x-api-key: magpie' \
    -H 'anthropic-version: 2023-06-01' \
    -d "{\"model\":\"$m\",\"max_tokens\":32,
         \"messages\":[{\"role\":\"user\",\"content\":\"reply with exactly: OK\"}]}" \
    | jq -c '{model, text: [.content[]?.text], error: .error.message}'
done
```

The `model` in the answer is the upstream's own name for what served the
request, and it is the same place the names of the other models are settled:
the catalog's 43 entries are 43 distinct `provider/model` pairs, and no model
name is registered twice on one pool.

## Models that are not in the pool

`qiniu/conatus-free` is a free channel on the `aikey4k` gateway. It is not a
routing-group member: it has its own global rate limit (the gateway answers
`free_campaign_global_limit`), and a group that mixes a free channel with
paid ones would spend the paid ones first.

It is registered on the `aikey4k` provider, so the gateway serves it as
`aikey4k/qiniu/conatus-free`, and its bare id `qiniu/conatus-free` also works.
Two nightly jobs on this machine use it, and both read the gateway's address and
token from `~/.claude/settings.json`:

| Job | Script |
| --- | --- |
| 01:00 disk analysis | `/opt/scripts/disk-analysis/llm_analysis.py` |
| 01:30 CNB branch analysis | `/opt/Octop/scripts/cnb_branch_analysis.py` |

Both name the model as `qiniu/conatus-free` and send no `thinking` field. The
gateway's model list must contain it, or both jobs fail with
`magpie knows no model "qiniu/conatus-free"` and their model section is
skipped. Add it with:

```sh
magpie provider models aikey4k +qiniu/conatus-free
```

Their own backoff (a staggered retry against the global limit) is what makes
them survive that limit; the gateway does not add one for this model.

## Checking the pool

```sh
magpie groups                     # the groups and their members
magpie providers                  # the pools, their keys and models
magpie group claude               # one group in full
magpie provider test aikey4k      # ask one pool directly
```

A request that should reach a pool, asked by hand:

```sh
curl -s http://127.0.0.1:3425/v1/messages \
  -H 'content-type: application/json' -H 'x-api-key: magpie' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"group/claude[1m]","max_tokens":32,
       "thinking":{"type":"adaptive"},
       "messages":[{"role":"user","content":"say OK"}]}'
```

Answering `OK` means the pool is reachable. A refusal about adaptive thinking
means the request left out its `thinking` field, and the caller needs the
setting above.

Which pool answered, and which group served it, is in the routing log:

```sh
# the last request: what was asked, what served it
tail -1 ~/.config/magpie/routing/$(date +%F).jsonl \
  | jq '{asked: .model, group: .group.ref, served: .provider, status: .status}'
```

`group` is empty for a request that named one pool outright — that is how a
request that skipped the groups can be spotted.

A request to the pool that is not supposed to reach it, checked by name:

```sh
# a name with a provider in front pins the pool; a group does not
curl -s http://127.0.0.1:3425/v1/messages \
  -H 'content-type: application/json' -H 'x-api-key: magpie' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"group/claude[1m]","max_tokens":32,
       "thinking":{"type":"adaptive"},
       "messages":[{"role":"user","content":"say OK"}]}'
```
