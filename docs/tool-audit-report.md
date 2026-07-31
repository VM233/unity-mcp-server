# Unity MCP 插件与工具逐项设计审查

生成时间：2026-07-31T12:28:38.247Z

## 结论

基线有 58 个 Node 工具和 127 个插件第一类工具，原始合计 185 项；按名称去重后为 174 项，并存在 11 个跨层同名碰撞。修复后默认面为 73 项，其中插件发布策略固定为 43 条路由。

174 个基线唯一工具的处理结果：默认保留 62、懒加载 85、合并 4、内部化 5、三段式 18。

当前默认面新增的规范入口：`unity_build`、`unity_editor_execute_code`、`unity_search_scene`、`unity_scene_instantiate_prefab`、`unity_jobs_cancel`、`unity_jobs_cleanup`、`unity_asset_import_settings_get`、`unity_asset_import_settings_set`、`unity_scene_workspace`、`unity_material_properties_get`、`unity_material_properties_set`。

## 整体框架审查与已实施修复

| 领域 | 发现的问题 | 已实施修复 | 当前判定 |
|---|---|---|---|
| 工具面 | 185 个原始条目会挤占上下文，且有 11 个同名跨层碰撞 | 建立 73 项默认面、43 路由发布策略和 lazy 兼容层 | 已修复 |
| 扩展性 | 项目自定义工具逐个展开，项目越大默认面越失控 | 统一为 `project-tools/list/get/execute` 三段式；不完整元数据自动降级 | 已修复 |
| 元数据 | 基线含 2 个内部工具、4 个默认描述、44 个数组缺 `items`、68 个属性缺描述 | 引入元数据质量门、完整 schema 递归审计和发布快照检查 | 已修复，当前 0 issue |
| 路由权威 | 路由清单、switch、Node 清单和 manifest 可漂移 | C# 权威路由注册表 + 实时快照生成 + manifest 同步检查 | 已修复 |
| 传输 | 直接端点与队列语义并存，重载时可能重复写入或丢失票据 | 全部命令统一经幂等队列；写操作不盲重放；丢票仅对白名单读操作恢复 | 已修复 |
| 就绪状态 | HTTP 监听成功会被误认为主线程队列可执行 | `queueReady`、冷启动结构化 503、测试期 `busyReason=test_run` | 已修复 |
| 队列生命周期 | 容量检查与入队不原子，执行超时与排队时间混淆，晚回调可覆盖结果 | 原子提交、分离 queue/execution 时间、按票据超时、终态拒绝晚回调 | 已修复 |
| 目标安全 | 写操作可在错误 Unity 实例执行 | 所有可变更 schema/请求统一支持并强制项目路径或名称绑定 | 已修复 |
| HTTP 边界 | 浏览器 Origin、错误方法、超大 body 和内部堆栈暴露风险 | Origin 拒绝、方法白名单、2 MiB body 限制、结构化无堆栈错误 | 已修复 |
| 回复噪声 | 重复实例上下文、成功 envelope、软限额警告块、包测试堆栈和整页失败明细 | 统一响应压缩；UTF-8 字节硬限额；堆栈显式 opt-in；包测试默认只给摘要 | 已修复 |
| 搜索重合 | 名称、组件、Tag、Layer、Shader 搜索入口高度重合 | 合并为 `search/scene`，旧路由保留 lazy 兼容 | 已修复 |
| Unity 兼容 | 分散对象搜索 API 在 Unity 版本间产生警告与维护重复 | 新增集中式 `MCPObjectSearch` 兼容层，Unity 6.4 编译 0 warning | 已修复 |
| 依赖安全 | 旧锁文件带入 8 个 npm 漏洞，其中 5 high | MCP SDK 最低版本升至 1.30.0，并刷新兼容传递依赖 | 已修复，`npm audit` 为 0 |
| 版本发布 | server、manifest 和文档版本可能各自漂移 | package.json 成为版本权威，生成器同时校验 manifest | 已修复 |

## 高度重合工具的合并结果

| 原入口 | 规范入口/处理 |
|---|---|
| `unity_search_by_name`、`unity_search_by_component` 以及 Tag/Layer/Shader 等场景搜索路由 | `unity_search_scene`；组合过滤、稳定分页 |
| `unity_build_start` 与 Node 构建入口 | `unity_build`；`unity_build_get_job` 单独保留作长任务查询 |
| `unity_editor_play_mode` 与 Node Play Mode 入口 | `unity_play_mode` |
| `unity_queue_ticket_status`、`unity_queue_status`、`unity_queue_cancel` | 内部队列控制面；普通调用方不再手工管理 |
| 18 个 `project-tools/call/*` | `unity_project_tools_list/get/execute` 三段式 |
| prefab batch/edit、component batch wire、asset move batch、本地化批处理别名 | 统一事务/配置入口；旧别名不再发布 |
| scene/game/prefab capture 与旧 graphics capture 别名 | 统一 screenshot/graphics 规范入口；过时别名不再发布 |

## 验证结果

- Unity 6000.4.10f1：编译 0 error / 0 warning。
- 插件元数据：43 个内建第一类路由，质量问题 0。
- Node：73 个默认工具，目录与 schema 自动测试通过。
- npm：生产依赖漏洞 0。
- 包测试：VMUnityMCP 5.6.6 全量 219/219 通过；最终元数据变更聚焦回归 2/2，manifest 精确恢复。

## 174 个基线唯一工具逐项审查

| # | 工具 | 原来源 | 原路由 | 处理 | 规范入口 | 审查结论 |
|---:|---|---|---|---|---|---|
| 1 | `unity_list_instances` | server | Node 静态 | 默认保留 | `unity_list_instances` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 2 | `unity_select_instance` | server | Node 静态 | 默认保留 | `unity_select_instance` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 3 | `unity_hub_list_editors` | server | Node 静态 | 默认保留 | `unity_hub_list_editors` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 4 | `unity_hub_available_releases` | server | Node 静态 | 默认保留 | `unity_hub_available_releases` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 5 | `unity_hub_install_editor` | server | Node 静态 | 默认保留 | `unity_hub_install_editor` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 6 | `unity_hub_install_modules` | server | Node 静态 | 默认保留 | `unity_hub_install_modules` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 7 | `unity_hub_get_install_path` | server | Node 静态 | 默认保留 | `unity_hub_get_install_path` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 8 | `unity_hub_set_install_path` | server | Node 静态 | 默认保留 | `unity_hub_set_install_path` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 9 | `unity_editor_ping` | server | Node 静态 | 默认保留 | `unity_editor_ping` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 10 | `unity_editor_state` | server | Node 静态 | 默认保留 | `unity_editor_state` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 11 | `unity_scene_info` | server | Node 静态 | 默认保留 | `unity_scene_info` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 12 | `unity_scene_open` | server | Node 静态 | 默认保留 | `unity_scene_open` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 13 | `unity_scene_save` | server | Node 静态 | 默认保留 | `unity_scene_save` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 14 | `unity_scene_new` | server | Node 静态 | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 15 | `unity_scene_hierarchy` | plugin | `scene/hierarchy` | 默认保留 | `unity_scene_hierarchy` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 16 | `unity_gameobject_create` | server | Node 静态 | 默认保留 | `unity_gameobject_create` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 17 | `unity_gameobject_delete` | server | Node 静态 | 默认保留 | `unity_gameobject_delete` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 18 | `unity_gameobject_info` | server | Node 静态 | 默认保留 | `unity_gameobject_info` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 19 | `unity_gameobject_set_transform` | server | Node 静态 | 默认保留 | `unity_gameobject_set_transform` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 20 | `unity_component_add` | server | Node 静态 | 默认保留 | `unity_component_add` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 21 | `unity_component_remove` | server | Node 静态 | 默认保留 | `unity_component_remove` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 22 | `unity_component_get_properties` | server | Node 静态 | 默认保留 | `unity_component_get_properties` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 23 | `unity_component_set_property` | plugin | `component/set-property` | 默认保留 | `unity_component_set_property` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 24 | `unity_component_get_referenceable` | server | Node 静态 | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 25 | `unity_asset_list` | plugin | `asset/list` | 默认保留 | `unity_asset_list` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 26 | `unity_asset_import` | plugin | `asset/import` | 默认保留 | `unity_asset_import` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 27 | `unity_asset_refresh` | plugin | `asset/refresh` | 默认保留 | `unity_asset_refresh` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 28 | `unity_asset_delete` | server | Node 静态 | 默认保留 | `unity_asset_delete` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 29 | `unity_asset_create_prefab` | server | Node 静态 | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 30 | `unity_script_create` | server | Node 静态 | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 31 | `unity_script_read` | server | Node 静态 | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 32 | `unity_script_update` | server | Node 静态 | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 33 | `unity_execute_code` | server | Node 静态 | 默认保留 | `unity_execute_code` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 34 | `unity_console_clear` | server | Node 静态 | 默认保留 | `unity_console_clear` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 35 | `unity_get_compilation_errors` | server | Node 静态 | 默认保留 | `unity_get_compilation_errors` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 36 | `unity_play_mode` | server | Node 静态 | 默认保留 | `unity_play_mode` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 37 | `unity_execute_menu_item` | server | Node 静态 | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 38 | `unity_project_info` | server | Node 静态 | 默认保留 | `unity_project_info` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 39 | `unity_prefab_info` | server | Node 静态 | 默认保留 | `unity_prefab_info` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 40 | `unity_gameobject_duplicate` | server | Node 静态 | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 41 | `unity_gameobject_set_active` | server | Node 静态 | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 42 | `unity_gameobject_reparent` | server | Node 静态 | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 43 | `unity_selection_get` | server | Node 静态 | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 44 | `unity_selection_set` | server | Node 静态 | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 45 | `unity_search_by_component` | server | Node 静态 | 合并 | `unity_search_scene` | 与同域工具高度重合，统一到 unity_search_scene。 |
| 46 | `unity_search_by_name` | server | Node 静态 | 合并 | `unity_search_scene` | 与同域工具高度重合，统一到 unity_search_scene。 |
| 47 | `unity_scene_stats` | server | Node 静态 | 默认保留 | `unity_scene_stats` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 48 | `unity_screenshot_game` | plugin | `screenshot/game` | 默认保留 | `unity_screenshot_game` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 49 | `unity_screenshot_scene` | server | Node 静态 | 默认保留 | `unity_screenshot_scene` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 50 | `unity_packages_list` | plugin | `packages/list` | 默认保留 | `unity_packages_list` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 51 | `unity_packages_update_git` | plugin | `packages/update-git` | 默认保留 | `unity_packages_update_git` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 52 | `unity_packages_lint_metas` | plugin | `packages/lint-metas` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 53 | `unity_queue_info` | plugin | `queue/info` | 默认保留 | `unity_queue_info` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 54 | `unity_queue_ticket_status` | server | Node 静态 | 内部化 | `Node 队列控制面` | 票据轮询与取消由传输层自动处理，不占用用户工具面。 |
| 55 | `unity_queue_cancel` | plugin | `queue/cancel` | 内部化 | `Node 队列控制面` | 票据轮询与取消由传输层自动处理，不占用用户工具面。 |
| 56 | `unity_list_advanced_tools` | server | Node 静态 | 默认保留 | `unity_list_advanced_tools` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 57 | `unity_advanced_tool` | server | Node 静态 | 默认保留 | `unity_advanced_tool` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 58 | `unity_get_project_context` | server | Node 静态 | 默认保留 | `unity_get_project_context` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 59 | `unity__meta_capabilities` | plugin | `_meta/capabilities` | 内部化 | `发布层元数据同步` | 内部发现协议不再作为普通用户工具显示。 |
| 60 | `unity__meta_tools` | plugin | `_meta/tools` | 内部化 | `发布层元数据同步` | 内部发现协议不再作为普通用户工具显示。 |
| 61 | `unity_animation_connect_states` | plugin | `animation/connect-states` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 62 | `unity_animation_transition_info` | plugin | `animation/transition-info` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 63 | `unity_animation_update_state` | plugin | `animation/update-state` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 64 | `unity_animation_update_transition` | plugin | `animation/update-transition` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 65 | `unity_asset_copy` | plugin | `asset/copy` | 默认保留 | `unity_asset_copy` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 66 | `unity_asset_create_folder` | plugin | `asset/create-folder` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 67 | `unity_asset_dependencies` | plugin | `asset/dependencies` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 68 | `unity_asset_export_unitypackage` | plugin | `asset/export-unitypackage` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 69 | `unity_asset_get_refresh_job` | plugin | `asset/get-refresh-job` | 默认保留 | `unity_asset_get_refresh_job` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 70 | `unity_asset_import_unitypackage` | plugin | `asset/import-unitypackage` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 71 | `unity_asset_move` | plugin | `asset/move` | 默认保留 | `unity_asset_move` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 72 | `unity_asset_rename` | plugin | `asset/rename` | 默认保留 | `unity_asset_rename` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 73 | `unity_asset_transaction` | plugin | `asset/transaction` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 74 | `unity_build_get_job` | plugin | `build/get-job` | 默认保留 | `unity_build_get_job` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 75 | `unity_build_start` | plugin | `build/start` | 合并 | `unity_build` | 与同域工具高度重合，统一到 unity_build。 |
| 76 | `unity_component_set_reference` | plugin | `component/set-reference` | 默认保留 | `unity_component_set_reference` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 77 | `unity_console_query` | plugin | `console/query` | 默认保留 | `unity_console_query` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 78 | `unity_editor_play_mode` | plugin | `editor/play-mode` | 合并 | `unity_play_mode` | 与同域工具高度重合，统一到 unity_play_mode。 |
| 79 | `unity_jobs_get` | plugin | `jobs/get` | 默认保留 | `unity_jobs_get` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 80 | `unity_jobs_list` | plugin | `jobs/list` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 81 | `unity_localization_collections` | plugin | `localization/collections` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 82 | `unity_localization_create_collection` | plugin | `localization/create-collection` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 83 | `unity_localization_create_locale` | plugin | `localization/create-locale` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 84 | `unity_localization_entries` | plugin | `localization/entries` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 85 | `unity_localization_locales` | plugin | `localization/locales` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 86 | `unity_localization_remove_entry` | plugin | `localization/remove-entry` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 87 | `unity_localization_remove_variable` | plugin | `localization/remove-variable` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 88 | `unity_localization_set_selected_locale` | plugin | `localization/set-selected-locale` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 89 | `unity_localization_settings` | plugin | `localization/settings` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 90 | `unity_localization_status` | plugin | `localization/status` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 91 | `unity_localization_upsert_entry` | plugin | `localization/upsert-entry` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 92 | `unity_localization_upsert_variable` | plugin | `localization/upsert-variable` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 93 | `unity_localization_validate` | plugin | `localization/validate` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 94 | `unity_localization_variables` | plugin | `localization/variables` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 95 | `unity_packages_add` | plugin | `packages/add` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 96 | `unity_packages_info` | plugin | `packages/info` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 97 | `unity_packages_remove` | plugin | `packages/remove` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 98 | `unity_packages_search` | plugin | `packages/search` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 99 | `unity_packages_status` | plugin | `packages/status` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 100 | `unity_prefab_asset_add_component` | plugin | `prefab-asset/add-component` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 101 | `unity_prefab_asset_add_gameobject` | plugin | `prefab-asset/add-gameobject` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 102 | `unity_prefab_asset_cleanup_missing_overrides` | plugin | `prefab-asset/cleanup-missing-overrides` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 103 | `unity_prefab_asset_configure_component` | plugin | `prefab-asset/configure-component` | 默认保留 | `unity_prefab_asset_configure_component` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 104 | `unity_prefab_asset_find` | plugin | `prefab-asset/find` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 105 | `unity_prefab_asset_get_properties` | plugin | `prefab-asset/get-properties` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 106 | `unity_prefab_asset_hierarchy` | plugin | `prefab-asset/hierarchy` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 107 | `unity_prefab_asset_instantiate_child_prefab` | plugin | `prefab-asset/instantiate-child-prefab` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 108 | `unity_prefab_asset_move_component` | plugin | `prefab-asset/move-component` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 109 | `unity_prefab_asset_move_gameobject` | plugin | `prefab-asset/move-gameobject` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 110 | `unity_prefab_asset_remove_component` | plugin | `prefab-asset/remove-component` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 111 | `unity_prefab_asset_remove_gameobject` | plugin | `prefab-asset/remove-gameobject` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 112 | `unity_prefab_asset_set_property` | plugin | `prefab-asset/set-property` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 113 | `unity_prefab_asset_set_reference` | plugin | `prefab-asset/set-reference` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 114 | `unity_prefab_asset_transaction_edit` | plugin | `prefab-asset/transaction-edit` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 115 | `unity_profiler_analyze` | plugin | `profiler/analyze` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 116 | `unity_profiler_enable` | plugin | `profiler/enable` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 117 | `unity_profiler_frame_data` | plugin | `profiler/frame-data` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 118 | `unity_profiler_memory` | plugin | `profiler/memory` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 119 | `unity_profiler_memory_breakdown` | plugin | `profiler/memory-breakdown` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 120 | `unity_profiler_memory_snapshot` | plugin | `profiler/memory-snapshot` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 121 | `unity_profiler_memory_snapshot_status` | plugin | `profiler/memory-snapshot-status` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 122 | `unity_profiler_memory_status` | plugin | `profiler/memory-status` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 123 | `unity_profiler_memory_top_assets` | plugin | `profiler/memory-top-assets` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 124 | `unity_profiler_stats` | plugin | `profiler/stats` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 125 | `unity_pt_battle_apply_knockback` | project | `project-tools/call/battleidle/apply-knockback` | 三段式 | `unity_project_tools_list/get/execute` | 项目动作不再永久展开；先发现、再取 schema、最后执行。 |
| 126 | `unity_pt_battle_generate_level_range` | project | `project-tools/call/battleidle/generate-level-range` | 三段式 | `unity_project_tools_list/get/execute` | 项目动作不再永久展开；先发现、再取 schema、最后执行。 |
| 127 | `unity_pt_battle_get_battle_state` | project | `project-tools/call/battleidle/get-battle-state` | 三段式 | `unity_project_tools_list/get/execute` | 项目动作不再永久展开；先发现、再取 schema、最后执行。 |
| 128 | `unity_pt_battle_get_combat_event_sample` | project | `project-tools/call/battleidle/get-combat-event-sample` | 三段式 | `unity_project_tools_list/get/execute` | 项目动作不再永久展开；先发现、再取 schema、最后执行。 |
| 129 | `unity_pt_battle_get_monster_animation_sample` | project | `project-tools/call/battleidle/get-monster-animation-sample` | 三段式 | `unity_project_tools_list/get/execute` | 项目动作不再永久展开；先发现、再取 schema、最后执行。 |
| 130 | `unity_pt_battle_get_role_equipment` | project | `project-tools/call/battleidle/get-role-equipment` | 三段式 | `unity_project_tools_list/get/execute` | 项目动作不再永久展开；先发现、再取 schema、最后执行。 |
| 131 | `unity_pt_battle_get_runtime_ready_state` | project | `project-tools/call/battleidle/get-runtime-ready-state` | 三段式 | `unity_project_tools_list/get/execute` | 项目动作不再永久展开；先发现、再取 schema、最后执行。 |
| 132 | `unity_pt_battle_inspect_monster_drop_table` | project | `project-tools/call/battleidle/inspect-monster-drop-table` | 三段式 | `unity_project_tools_list/get/execute` | 项目动作不再永久展开；先发现、再取 schema、最后执行。 |
| 133 | `unity_pt_battle_inspect_world_drops` | project | `project-tools/call/battleidle/inspect-world-drops` | 三段式 | `unity_project_tools_list/get/execute` | 项目动作不再永久展开；先发现、再取 schema、最后执行。 |
| 134 | `unity_pt_battle_play_mode_summary` | project | `project-tools/call/battleidle/play-mode-summary` | 三段式 | `unity_project_tools_list/get/execute` | 项目动作不再永久展开；先发现、再取 schema、最后执行。 |
| 135 | `unity_pt_battle_set_role_equipment` | project | `project-tools/call/battleidle/set-role-equipment` | 三段式 | `unity_project_tools_list/get/execute` | 项目动作不再永久展开；先发现、再取 schema、最后执行。 |
| 136 | `unity_pt_battle_simulate_monster_drop_table` | project | `project-tools/call/battleidle/simulate-monster-drop-table` | 三段式 | `unity_project_tools_list/get/execute` | 项目动作不再永久展开；先发现、再取 schema、最后执行。 |
| 137 | `unity_pt_battle_start_current_battle` | project | `project-tools/call/battleidle/start-current-battle` | 三段式 | `unity_project_tools_list/get/execute` | 项目动作不再永久展开；先发现、再取 schema、最后执行。 |
| 138 | `unity_pt_battle_start_game` | project | `project-tools/call/battleidle/start-game` | 三段式 | `unity_project_tools_list/get/execute` | 项目动作不再永久展开；先发现、再取 schema、最后执行。 |
| 139 | `unity_pt_battle_update_monster_drop_table` | project | `project-tools/call/battleidle/update-monster-drop-table` | 三段式 | `unity_project_tools_list/get/execute` | 项目动作不再永久展开；先发现、再取 schema、最后执行。 |
| 140 | `unity_pt_battle_upsert_item_content` | project | `project-tools/call/battleidle/upsert-item-content` | 三段式 | `unity_project_tools_list/get/execute` | 项目动作不再永久展开；先发现、再取 schema、最后执行。 |
| 141 | `unity_pt_battle_upsert_level_node` | project | `project-tools/call/battleidle/upsert-level-node` | 三段式 | `unity_project_tools_list/get/execute` | 项目动作不再永久展开；先发现、再取 schema、最后执行。 |
| 142 | `unity_pt_battle_validate_game_content` | project | `project-tools/call/battleidle/validate-game-content` | 三段式 | `unity_project_tools_list/get/execute` | 项目动作不再永久展开；先发现、再取 schema、最后执行。 |
| 143 | `unity_project_tools_execute` | plugin | `project-tools/execute` | 默认保留 | `unity_project_tools_execute` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 144 | `unity_project_tools_get` | plugin | `project-tools/get` | 默认保留 | `unity_project_tools_get` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 145 | `unity_project_tools_list` | plugin | `project-tools/list` | 默认保留 | `unity_project_tools_list` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 146 | `unity_queue_status` | plugin | `queue/status` | 内部化 | `Node 队列控制面` | 票据轮询与取消由传输层自动处理，不占用用户工具面。 |
| 147 | `unity_serialized_object_get` | plugin | `serialized-object/get` | 默认保留 | `unity_serialized_object_get` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 148 | `unity_serialized_object_set` | plugin | `serialized-object/set` | 默认保留 | `unity_serialized_object_set` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 149 | `unity_testing_get_job` | plugin | `testing/get-job` | 默认保留 | `unity_testing_get_job` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 150 | `unity_testing_get_package_job` | plugin | `testing/get-package-job` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 151 | `unity_testing_list_tests` | plugin | `testing/list-tests` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 152 | `unity_testing_run_package_tests` | plugin | `testing/run-package-tests` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 153 | `unity_testing_run_tests` | plugin | `testing/run-tests` | 默认保留 | `unity_testing_run_tests` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 154 | `unity_texture_apply_sprite_preset` | plugin | `texture/apply-sprite-preset` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 155 | `unity_texture_find_duplicates` | plugin | `texture/find-duplicates` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 156 | `unity_texture_info` | plugin | `texture/info` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 157 | `unity_uitoolkit_assert_layout` | plugin | `uitoolkit/assert-layout` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 158 | `unity_uitoolkit_asset_inspect` | plugin | `uitoolkit/asset-inspect` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 159 | `unity_uitoolkit_audit_uss_styles` | plugin | `uitoolkit/audit-uss-styles` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 160 | `unity_uitoolkit_audit_uxml_layout` | plugin | `uitoolkit/audit-uxml-layout` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 161 | `unity_uitoolkit_authoring_transaction` | plugin | `uitoolkit/authoring-transaction` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 162 | `unity_uitoolkit_builder_preview` | plugin | `uitoolkit/builder-preview` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 163 | `unity_uitoolkit_capture_element` | plugin | `uitoolkit/capture-element` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 164 | `unity_uitoolkit_compare_element` | plugin | `uitoolkit/compare-element` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 165 | `unity_uitoolkit_edit_uss` | plugin | `uitoolkit/edit-uss` | 默认保留 | `unity_uitoolkit_edit_uss` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 166 | `unity_uitoolkit_edit_uxml` | plugin | `uitoolkit/edit-uxml` | 默认保留 | `unity_uitoolkit_edit_uxml` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 167 | `unity_uitoolkit_locate_element` | plugin | `uitoolkit/locate-element` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 168 | `unity_uitoolkit_refresh` | plugin | `uitoolkit/refresh` | 默认保留 | `unity_uitoolkit_refresh` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 169 | `unity_uitoolkit_runtime_documents` | plugin | `uitoolkit/runtime-documents` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 170 | `unity_uitoolkit_runtime_query` | plugin | `uitoolkit/runtime-query` | 默认保留 | `unity_uitoolkit_runtime_query` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |
| 171 | `unity_uitoolkit_runtime_repaint` | plugin | `uitoolkit/runtime-repaint` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 172 | `unity_uitoolkit_runtime_style` | plugin | `uitoolkit/runtime-style` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 173 | `unity_uitoolkit_runtime_tree` | plugin | `uitoolkit/runtime-tree` | 懒加载 | `unity_advanced_tool` | 能力保留，但从默认上下文移出；按需通过高级入口执行。 |
| 174 | `unity_wait_editor_idle` | plugin | `wait/editor-idle` | 默认保留 | `unity_wait_editor_idle` | 唯一默认入口；描述与输入 schema 已通过自动质量门。 |

## 审查边界

“懒加载”不是删除能力：路由仍由 Unity 插件保留，并可通过高级入口按需执行；“内部化”则表示该能力属于发现或传输控制面，不应作为普通用户工具暴露。
