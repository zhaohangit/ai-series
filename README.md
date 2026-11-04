# AI Series

独立运行的 React + Python 漫剧创作应用。数据库、对象存储和任务队列在本地 OrbStack 中运行。

## 启动

```sh
python3 tools/bootstrap-env.py
docker compose up -d --build
```

网页：`http://127.0.0.1:5175/home`。API：`http://127.0.0.1:8001/api/health`。首次访问创建独立的本地浏览器账号，使用持久 Cookie。

| 服务 | 本机端口 | 持久化 |
|---|---|---|
| React / Nginx | 5175 | 构建产物 |
| FastAPI | 8001 | PostgreSQL + S3 |
| PostgreSQL 18 | 25432 | ai-series_postgres_data |
| Redis / Celery | 26379 | ai-series_redis_data |
| MinIO S3 / 控制台 | 29000 / 29001 | ai-series_storage_data |

所有端口只绑定 loopback；不复用或改动其他项目容器。`.env` 由脚本生成随机本地凭据，不入库。`docker compose down` 停止服务并保留数据；不要使用 `down -v`，除非确实要删除该项目的数据。

## 已实现的工作流

- 首页三种创作入口、作品分类与搜索、新建/重命名/复制/删除。
- 剧本保存、明确标注的本地规则拆集拆镜、分集与分镜编辑、风格设置、角色场景素材上传。
- 项目主体详情、主视觉/设定图/音色保存；真实14个角色预设库146个角色可浏览并导入本地；手动4/9宫格和PNG导出。
- 图片/视频/音频分镜编辑页，生成任务/历史/失败反馈，生成结果与目标版本比较后应用。
- XYFlow 画布节点、连接、移动、缩放、文件导入、保存/恢复、版本冲突检测。
- 画布子图复制/粘贴/副本、内部连线重映射、父子节点删除/撤销、导入校验及快捷键。
- PostgreSQL 所有权隔离、S3 文件读回、HTTP Range、队列任务、幂等提交、失败返还本地额度。
- 真实 FFmpeg MP4 合成、ZIP 素材包及 JSON 项目导出；没有素材时明确拒绝合成。
- 本地 MCP API key 创建/撤销和 8 个实际工具；单次展示密钥，只存哈希。详见 [MCP 文档](backend/docs/mcp.md)。
- 内置 24 种风格、117 个模型目录变体、9 个绘图模板、56 条更新公告作为只读目录；目录条目不表示对应生成模型已配置或可用。

## AI 服务

默认不配置任何外部模型。未配置的生成请求返回 503，且不扣本地额度。`.env.example` 定义 text/image/audio/video provider 变量；参阅 [适配器契约](backend/docs/providers.md)。音频/视频适配器已通过本地 HTTP 服务测试，尚未使用真实外部供应商凭据验证；视频适配器需要服务支持文档中的 JSON 作业契约。

本地额度仅是演示账本，与供应商实际账单无关。生成服务需要单独配置供应商。

## 验证

```sh
uv sync --directory backend
uv run --directory backend pytest -q
npm ci --prefix web
npm test --prefix web
npm run build --prefix web
python3 tools/test-backend.py
```

完整后端集成测试使用独立临时 PostgreSQL schema、MinIO bucket、Celery queue；`FFMPEG_BIN` 指定本机 FFmpeg 时包含实际媒体合成检查。默认测试对未配置依赖明确 skip。可选浏览器检查工具需要本机 Chrome；运行前需按本机环境调整工具中的 Playwright 依赖路径。检查使用独立无头浏览器账号创建测试作品，输出至 `artifacts/verification/`。

## 目录

- `web/src/`：可维护的 React/TypeScript 源码。
- `backend/app/`：Python API、持久化、provider、MCP、任务和媒体导出。
- `compose.yaml`：独立 OrbStack 服务。
- `web/public/reference/`：应用使用的图片、字体与只读目录数据。
- `docs/api-contract.md`：本地 API 契约。
