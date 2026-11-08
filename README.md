# dsh-plugin-sub2api-sticky

让 DeepSeek Harness 的每个对话固定在 [Sub2API](https://github.com/Wei-Shaw/sub2api) 的同一个上游 Claude 账号上，并改用 1 小时提示缓存。无设置、无界面，装上即生效。

```bash
dsh plugin --profile web add github:mercy719/dsh-plugin-sub2api-sticky#main
```

装完重启 dsh。升级到新版：`dsh plugin --profile web update dsh-plugin-sub2api-sticky` 后重启。卸载：`dsh plugin --profile web remove dsh-plugin-sub2api-sticky`。

## 为什么需要

Sub2API 靠 `metadata.user_id` 判断请求属于哪个会话。dsh 不发这个字段，Sub2API 只能拿带 `cache_control` 的那条消息算会话 hash，而 dsh 每轮只标记最后一条消息，所以 hash 每轮都变。结果是同一个对话在多个账号之间跳，每跳一次整段上下文重写缓存。

本插件给每个 Anthropic 请求补上 Claude Code 格式的 `user_id`：`user_<设备hash>_account__session_<由 dsh sessionId 派生的 uuid>`。同一个对话（包括它的每个子 agent 各自）始终是同一个值。

- 默认改用 1 小时缓存（`cacheRetention: long`）。默认的 5 分钟缓存在停顿 5 分钟以上后就会过期，回来时要整段重写上下文；1 小时缓存写入单价更高（基础输入的 2 倍，5 分钟档是 1.25 倍），但停顿回来能直接命中。在 provider 配置里显式设置了 `cacheRetention` 时以你的设置为准。
- 只处理 `anthropic-messages` 协议的请求，其他协议原样放行。
- 请求里已经有 `metadata.user_id` 时不覆盖。
- 设备 hash 来自 dsh 自带的匿名 ID，取 sha256，不含主机名、IP 等身份信息。
- 不改官方 `llm-pi-ai` 的配置，不注册 provider。

## 验证

在 Sub2API 日志里，dsh 的请求应出现 `sticky.hash_source ... "source": "metadata_user_id"`，同一个对话始终落在同一个账号上。

---

Keeps each DeepSeek Harness conversation on one Sub2API upstream Claude account by adding a stable, Claude Code–format `metadata.user_id` (derived from the dsh session id) to every Anthropic request, and defaults Anthropic requests to the 1-hour prompt cache unless `cacheRetention` is set explicitly. No settings, no UI. Install with the command above and restart dsh.

The adapter hook point is adapted from [@mzzsfy/dsh-llm-pi-gateway](https://github.com/mzzsfy/dsh-plugin) (MIT), whose `dsh:<hash>` marker Sub2API does not parse.
