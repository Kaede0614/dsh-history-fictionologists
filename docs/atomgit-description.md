# AtomGit 平台备忘与仓库描述文案（dsh-history-fictionologists）

> 事实来源：本机对 `api.atomgit.com` 与 `atomgit.com` 的**实测探针**（命令与原始输出见 §5），
> 以及官方 OpenAPI 文档 <https://docs.atomgit.com/docs/apis/>。
> 本文既是 About 文案备料，也是 `scripts/release-atomgit.mjs` 为什么长成那样的依据。

---

## 1. 为什么单开一份 AtomGit 文档

AtomGit 不是「换了个域名的 GitHub」。把 `lib/release-kit.mjs` 的主机名一改就发版，
会在四个地方撞墙，其中两个**静默失败**。以下四条都是实测或官方文档确认的：

| # | 差异 | 照搬 GitHub 的后果 |
|---|---|---|
| 1 | 认证头是 GitLab 风格的 **`PRIVATE-TOKEN`**（`Authorization: Bearer` 官方也认） | 用 `Authorization: token …` 会拿到 `401 token not found` |
| 2 | Release 响应里**没有数字 `id`**，只有 `tag_name` | 后续「传附件 / 改正文」全部无从下手 |
| 3 | **没有** `POST /releases/:id/attach_files`；附件走**签名两步法** | 该接口在 AtomGit 上返回 404 |
| 4 | **同名附件覆盖不生效**（PUT 返回成功，下载拿到的还是旧文件） | 修了 bug 重新上传，用户下到的还是旧制品——**静默失败** |

签名两步法：先 `GET /api/v5/repos/:owner/:repo/releases/:tag/upload_url?file_name=<名字>`
拿到一个对象存储（OBS）的预签名 URL **和一组 `x-obs-*` 请求头**；
再把这些头**原样**带回 `PUT` 内容。少了任何一个 `x-obs-*`，对象存储要么拒绝，
要么写入成功但**回调不触发**——附件在 Release 页面上就是不出现。

> 另有一条来自社区实测记录（<https://www.wsisp.com/helps/103253.html>）：
> `PATCH /releases/:tag` **不接受部分更新**，必须把 `tag_name` / `target_commitish` /
> `name` / `body` / `prerelease` / `draft` 全量传一遍，否则报 `PARAMETER_ERROR must not be blank`。
> 本仓库的脚本因此对「创建」和「更新」发送**同一个完整 body**。

---

## 2. About 短描述

GitHub 的上限是 350 字符；AtomGit 的输入框更窄，沿用同一句即可（105 字符）：

```
基于《崩坏：星穹铁道》官方世界观的 DSH 二创插件（/gs）：神人制造机出科幻灵感、构史文集写短篇、星际构史播报编新闻；12 个 Wiki 数据源增量抓取并本地缓存，抓不到就自动回退缓存。非营利二创，MIT。
```

英文备选（面向检索，226 字符）：

```
A DeepSeek Harness (DSH) plugin (/gs) for Honkai: Star Rail fan fiction: story ideas, short stories and fake interstellar news built on 12 incrementally cached Bwiki datasets. Unofficial, non-commercial fan work.
```

---

## 3. 安装地址（给 README / Release 正文用）

```powershell
# AtomGit（国内网络更稳）
dsh plugin --profile <profile> add https://atomgit.com/Scombriformes/dsh-history-fictionologists

# GitHub
dsh plugin --profile <profile> add github:Kaede0614/dsh-history-fictionologists
```

`package.json` 里的 `repository` / `homepage` / `bugs` 仍然指向 GitHub：
**AtomGit 是分发镜像，不是主仓**。这一点是有意为之——不要为了「双平台对等」
把字段改成其中之一，那样只会让两边各说各话。

---

## 4. 发版命令

```powershell
# 预演：只打计划，不写任何东西（本条无需令牌）
node scripts/release-atomgit.mjs --repo Scombriformes/dsh-history-fictionologists

# 首次建仓 + 推 main + 推 tag + 建 Release + 传 tgz + 下载回验
node scripts/release-atomgit.mjs --publish --create-repo

# 之后每次发版（仓库已存在）
node scripts/release-atomgit.mjs --publish --repo Scombriformes/dsh-history-fictionologists
```

前置条件只有一条：在 <https://atomgit.com/setting/token-classic> 建一把 classic 令牌，
**并且勾上权限**（`api`、`read_user`、`read_repository`、`write_repository`），
写进仓库根的 `.atomgit-token`（**已 gitignore**）或环境变量 `ATOMGIT_TOKEN`。
**什么都不勾的令牌「有效但什么都做不了」**——见 §5.1 的实测两种报错。

令牌的两种用法都不进日志、不进 argv：

- API 调用走 `PRIVATE-TOKEN` 请求头；
- `git push` 走一次性 `credential.helper`，它从环境变量读密码
  （`-c credential.helper=` 先清空继承来的 helper，否则本机的 Git Credential Manager
  不认识 `atomgit.com`，会退回交互式提示）。

脚本与 GitHub 支路一样是**幂等**的：Release 已存在就 `PATCH`，同名附件先 `DELETE` 再上传
（第 4 条差异决定这一步不能省），传完把附件**下载回来比 sha256**——
「API 里有一个同名附件」和「用户下到的字节就是我们构建的字节」不是一回事。

---

## 5. 实测探针（原始命令与输出）

```powershell
# 连通性：api.atomgit.com 可达
Invoke-WebRequest -Uri "https://api.atomgit.com" -Method Head -TimeoutSec 20
# -> HTTP 200

# 账号存在
Invoke-RestMethod "https://api.atomgit.com/api/v5/users/Scombriformes"
# -> login=Scombriformes, id=6ab48d892985d10201b6ecc6, created_at=2026-09-24T10:40:09+08:00

# 仓库不存在时：git 传输层返回 403 + 「project could not be found」
git ls-remote --heads --tags https://atomgit.com/Scombriformes/dsh-history-fictionologists.git
# -> remote: <CH.00905403> The project you were looking for could not be found. Request-id is jcxy2fNaFp.
#    fatal: ... The requested URL returned error: 403

# 仓库存在时：branches 端点 200，且能读到分支与提交
Invoke-RestMethod "https://api.atomgit.com/api/v5/repos/<owner>/<repo>/branches"
# -> 200 [{"name":"main","commit":{...}}]

# 404 是「没有 Release」而不是「没有仓库」的常规信号（本仓库发布前实测）
Invoke-WebRequest "https://api.atomgit.com/api/v5/repos/<owner>/<repo>/releases/tags/v0.2.0"
# -> 404

# 同一个「不存在」，**不同端点和不同传输层给的状态码都不一样**（实测，见 _evidence/atomgit-probe.txt）
#   GET /repos/:owner/:repo            （匿名） -> 401 {"message":"401 Unauthorized"}
#   GET /repos/:owner/:repo/branches   （匿名） -> 404 {"error_message":"Project not found:…"}
#   git ls-remote https://atomgit.com/:owner/:repo.git -> 403 project could not be found
# 发布脚本走 Node fetch，且**存在性探测专门问 /branches** —— 只有子资源能区分
# 「确实没有」和「没登录」。这条差异已写进 lib/atomgit-kit.mjs 的 describeAtomgitFailure 注释。
```

再跑一遍全部只读探针（脚本只读、只 GET，**从不打印令牌**）：

```powershell
node _evidence/atomgit-probe.mjs | Tee-Object -FilePath _evidence/atomgit-probe.txt
```

---

## 5.1 令牌的 scope 不能留空（实测踩过）

在 <https://atomgit.com/setting/token-classic> 建令牌时**必须勾权限**，否则令牌「有效但什么都不能做」：

```powershell
# 一个没勾任何 scope 的令牌，实测表现：
GET /api/v5/user                    -> 403  {"error_code_name":"FORBIDDEN","error_message":"no scopes:read_user"}
GET /api/v5/repos/:owner/:repo/...  -> 403  {"error_code_name":"UN_KNOW",
                                       "error_message":"CH.00000403 apig token has not permission to request url"}
```

两种报错长得完全不同，但根因是一个。本工具链需要的 scope：

```
api  read_user  read_repository  write_repository
```

（`issues` / `pull_requests` 本流程用不到，要提 Issue 再勾。）
`lib/atomgit-kit.mjs` 的 `ATOMGIT_SCOPES` 就是这份清单，并会把它写进 403 的报错正文里。


---

## 6. 一段需要如实记录的历史

AtomGit 上**曾经**有一个同名仓库（`Scombriformes/dsh-history-fictionologists`），
装的是本项目的一个**旧原型**：

```
.gitattributes  .gitignore  CHANGELOG.md  cordis.patch.yml  data/worldbook.json
index.js  lib/args.js  lib/extract.js  lib/fetch.js  lib/prompts.js  lib/sources.js
LICENSE  README.md  RELEASE-NOTES-v0.1.0.md  RELEASE-NOTES-v0.1.1.md
```

（`GET /api/v5/repos/:owner/:repo/git/trees/:sha?recursive=1` 实测输出。）

它与当前代码**没有任何共同提交历史**：旧仓 `main` 停在 `cc09bd5`（v0.1.1，
`/fictionologist` 命令、14 个数据源、108 个单测），当前工作区是单提交的 `b8221bc`（v0.2.0，
`/gs` 命令、12 个数据源、124 个单测），`git merge-base` 为空。
所以本次发布是**重新建仓**，而不是在旧仓上追加——旧仓由作者在 2026-09-26 删除。

记这一段的理由：AtomGit 上曾出现 `v0.1.1`，而当前代码是 `0.2.x`（GitHub 上 `v0.2.0`，
本次发 `v0.2.1`），看起来像「同一个仓库的版本往回走」。事实不是倒退，是两条血脉，
而其中一条已经作废。本次是**重新建仓**，新仓的第一个 tag 就是 `v0.2.1`。
