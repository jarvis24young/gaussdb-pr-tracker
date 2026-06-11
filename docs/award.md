摘要

本 Idea 面向 GaussDB ODBC/JDBC 等数据库驱动质量加固场景，提出一套“上游社区已合入 PR 自动追踪 + 本地源码相似风险分析 + AI 专家化判断”的工具化方案。数据库驱动大量代码与 PostgreSQL 生态上游项目存在历史关联，上游社区已修复的 Bug、兼容性问题、内存安全问题和边界条件问题，往往是内部产品质量排查的高价值线索。传统方式依赖人工浏览社区 PR、阅读 patch、查找本地相似代码、判断是否同步修复，效率低、专家依赖强、容易遗漏。 该工具可自动拉取 psqlODBC、pgjdbc 等上游仓库已合入 PR，按驱动类型匹配本地 GaussDB ODBC/JDBC 代码路径，抽取 patch 中的函数名、标识符、新增/删除代码行等关键证据，结合规则引擎与大模型分析，输出 HIGH/MEDIUM/LOW/N/A 风险等级、本地命中文件、函数级证据、风险原因和修复建议。该方案可用于驱动质量加固、开源修复同步、历史缺陷补漏、版本发布前风险排查等场景，预期显著提升研发和测试团队对上游社区缺陷的消化效率，降低客户现场问题和存量隐患风险。

创意详情

**场景问题**

GaussDB 数据库驱动需要长期面对兼容性、稳定性、内存安全、协议交互、边界参数处理等质量挑战。ODBC/JDBC 驱动代码与 PostgreSQL 生态上游项目存在较强关联，上游社区中已经合入的 Bug Fix PR，实际上可以看作一批经过社区验证的“高价值质量情报”。这些 PR 可能对应空指针、数组越界、状态机异常、连接参数解析错误、结果集处理异常、兼容性缺陷、性能退化等问题。如果内部代码仍保留类似逻辑，就可能在后续客户场景中暴露为稳定性问题、兼容性问题甚至安全风险。

当前这类排查主要依赖人工完成，存在几个明显痛点：

第一，人工追踪成本高。研发或测试人员需要定期浏览上游社区 PR，筛选出已合入且与驱动质量相关的修复，再逐个阅读 patch 和 issue 背景，时间成本较高。

第二，本地代码比对难度大。内部代码经过长期演进后，文件名、函数结构、局部实现可能与上游存在差异，不能简单依靠关键词搜索判断是否存在同类问题，需要结合函数级上下文、调用链、修复前后逻辑差异进行判断。

第三，专家经验依赖强。是否属于真实风险、是否已经修复、是否只影响测试代码、是否需要同步修复，往往依赖资深开发经验，新人或非模块责任人难以快速判断。

第四，质量线索难以沉淀。人工排查结果通常散落在个人笔记、聊天记录或临时文档中，难以形成可复用的 PR 风险分析台账，后续版本排查和审计复盘成本较高。

第五，客户侧风险前移不足。很多上游已暴露并修复的问题，如果内部没有及时同步分析，可能在客户使用、版本升级、兼容测试或特殊业务场景中再次暴露，影响产品质量口碑和交付效率。

本 Idea 通过 AI 工具化方式，将“上游社区修复”转化为“内部产品质量风险情报”，把被动响应客户问题前移为主动风险排查，可应用于数据库驱动、数据库内核、开源数据库发行版、云数据库服务、基础软件兼容层、中间件、国产化迁移适配等场景。

**方案描述**

**![image](https://wiki.huawei.com/vision-file-storage/api/file/download/upload-v2/WIKI2026051811121740/43783887/40d082e0515d4abc8946510ae332b154.png)**

本方案建设一个面向数据库驱动研发与测试团队的 AI 辅助质量风险分析平台，当前原型为 **GaussDB Driver PR Tracker**。工具面向 GaussDB ODBC/JDBC 驱动维护人员、测试人员、质量加固人员和版本发布前风险排查人员使用，核心目标是把上游社区已修复问题自动转化为内部代码风险排查任务。

工具整体流程如下：

1. **自动拉取上游社区已合入 PR**  
   支持按驱动 Profile 配置上游来源，例如 ODBC 对应 psqlODBC 社区，JDBC 对应 pgjdbc 社区。工具自动拉取 closed 且 merged 的 PR 列表，作为质量风险分析入口。  
   ![image](https://wiki.huawei.com/vision-file-storage/api/file/download/upload-v2/WIKI2026051811121740/43803886/dcca764810d64f168c50a9084f31dfc7.png)
2. **按本地驱动仓库进行源码映射**  
   用户配置本地 GaussDB ODBC/JDBC 代码路径后，工具根据上游变更文件名、目录结构、源文件类型等信息，查找本地是否存在对应产品源码文件。
3. **过滤非产品代码，降低误判**  
   工具会过滤明显的 test、docs、example 等目录和测试命名文件，避免把上游测试补充误判为产品代码风险，同时保留真实产品源文件分析。
4. **抽取 patch 关键证据**  
   从上游 PR patch 中提取函数名、标识符、新增代码行、删除代码行、hunk header 等信息，形成结构化证据，避免让大模型直接面对大段源码而产生误判。  
   ![image](https://wiki.huawei.com/vision-file-storage/api/file/download/upload-v2/WIKI2026051811121740/43803948/08d3d6be2a9849a6b1e1cf8736b85136.png)
5. **规则引擎预判修复状态**  
   后端优先执行确定性规则判断，例如本地是否命中上游新增修复代码、本地是否仍保留上游删除的旧逻辑、本地是否同时存在新旧逻辑、本地是否缺少对应文件等。对于高置信命中场景，可直接给出初步结论，降低模型调用成本和不稳定性。  
   ![image](https://wiki.huawei.com/vision-file-storage/api/file/download/upload-v2/WIKI2026051811121740/43810679/515ccbf7f0934bfebcc668aac81d3207.png)
6. **AI 专家化分析与解释**  
   在规则预判基础上，调用大模型按数据库驱动专家视角分析本地代码与上游修复的等价关系，输出风险等级、判断理由、本地证据、潜在影响、建议修复方向和测试建议。
7. **可视化风险台账沉淀**  
   前端以列表和详情面板方式展示社区 PR、分析状态、风险等级、命中文件、分析结论和修复建议。支持单个 PR 分析、批量选择分析、风险筛选和缓存复用，形成可持续维护的质量风险台账。

预期效果方面，该工具可将单个上游 PR 的人工初筛和本地相似风险判断，从传统人工阅读、搜索、比对的 3–6 分钟，压缩到约 30s 内完成初步判断；批量排查场景下，预计可提升 10–20 倍质量分析效率。对于版本质量加固、历史缺陷补漏、发布前风险扫描等场景，可帮助团队更早发现潜在缺陷，减少客户现场问题，提升开源修复同步效率和产品可靠性。  
![](https://jx.huawei.com/JCHeader/v1/oneboxfile/v1/oneboxFile?url=api/v2/files/9406910/334774/url)

相比传统人工排查方式，本方案的创新点在于：不是简单调用 AI 问答，而是将“上游 PR 结构化解析、源码匹配、规则预判、函数级上下文抽取、AI 专家解释、风险台账沉淀”形成闭环，兼顾自动化效率和工程可信度。该方案后续还可以扩展到数据库内核、libpq、客户端工具、数据库中间件、云服务控制面等更多代码库，形成面向基础软件质量加固的通用 AI 风险分析平台。目前，该项目已完成demo，可实际进行运行并且支持多模型配置方案。  
核心工作流设计

用户启动工具后，需要配置：

- 驱动 Profile：ODBC 或 JDBC。
- 当前 Profile 对应的本地 GaussDB 驱动仓库路径。
- AI 接口类型和模型。
- GitHub Token。
- 可选 HTTP 代理。

工具支持从 ClaudeCode 自动导入 AI 配置，减少内网迁移成本  
![image](https://wiki.huawei.com/vision-file-storage/api/file/download/upload-v2/WIKI2026051811121740/43803745/724685669b7742e8a3c7fadff6c97a1a.png)

工具按驱动 Profile 从 GitHub API 拉取对应上游仓库中 closed 且已 merge 的 PR，并在页面展示。当前支持的 Profile 包括 ODBC 和 JDBC：

| Profile | 上游来源                             | 本地代码路径          |
| ------- | -------------------------------- | --------------- |
| ODBC    | `postgresql-interfaces/psqlodbc` | GaussDB ODBC 仓库 |
| JDBC    | `pgjdbc/pgjdbc`                  | GaussDB JDBC 仓库 |

说明：libpq 暂不纳入当前 PR 追踪模型。`postgres/postgres` 在 GitHub 上不适合按 merged PR 工作流获取修复线索，而是邮箱列等。  
![image](https://wiki.huawei.com/vision-file-storage/api/file/download/upload-v2/WIKI2026051811121740/43803886/dcca764810d64f168c50a9084f31dfc7.png)

工具支持批量分析未分析 PR，适合阶段性质量专项：

- 批量扫描历史 merged PR。

- 自动生成风险台账。

- 高风险项优先复核。  
  ![image](https://wiki.huawei.com/vision-file-storage/api/file/download/upload-v2/WIKI2026051811121740/43804214/f18d20c42bed43519922c35618a92025.png)
  
  为了适配研发人员已有的 ClaudeCode 环境，工具支持扫描：
  
  - `~/.claude/settings.json`
  - `~/.claude.json`
  - `%APPDATA%\Claude\settings.json`
  - `%LOCALAPPDATA%\claude-cli-nodejs\settings.json`
  - `~/.cc-switch/backups/env-backup-*.json`
  
  导入时会展示候选配置来源、模型、Base URL 和脱敏 token，用户选择后写入本项目的 `data/settings.json`。  
  ![image](https://wiki.huawei.com/vision-file-storage/api/file/download/upload-v2/WIKI2026051811121740/43806380/c2fae98c2e1249d59f920cfd3e398d41.png)
  
  ## 实践复盘
  
  1. AI 工具必须围绕真实研发流程设计。
  2. 质量场景不能只要摘要，必须要证据。
  3. 若想真实成为内部生产力工具，黄区还要考虑内网模型、代理、Token、端口等工程问题。
  4. AI 输出不稳定是常态，合理设计Skills和相关Prompt流程是关键。
  
  ## GaussDB Driver PR Tracker 是一次面向数据库驱动真实质量加固场景的 AI 辅助研发实践。该工具以上游 PostgreSQL 开源生态中的已合入 PR 作为质量演进信号，以 GaussDB ODBC / JDBC 等本地驱动实现为分析对象，通过自动化拉取 PR 信息、解析变更内容、匹配本地代码、构造 AI 分析上下文、判断同步状态并输出结构化结果，形成了一套可视化、可复核、可沉淀、可持续运行的驱动质量风险排查流程。
