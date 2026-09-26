# 侧栏分组拖动

- “项目”视图中的会话只保留点击和菜单操作，不响应鼠标左键拖动。
- “分组”视图保留会话排序、跨组移动和分组标题排序。参考 `reference/zcode/packages/ui/src/WorkspaceGroupedTasksSection.tsx` 的完整拖动预览：先从当前所有容器移除会话，再插入目标位置，途经分组不会残留副本。
- 鼠标松开前不保存。松开后只保存最终变动的容器；拖回原位置不写入。保存期间保留最终位置，失败后显示已确认的数据并提示错误。
- “未分组”有独立标题、数量、折叠按钮，支持全部展开／折叠并记住状态。空列表和折叠标题仍是有效拖入位置，未保存的当前会话也在折叠范围内。
- 拖动至少 5px 才进入预览。拖动后的点击不会打开会话或切换分组折叠状态；Esc、指针取消、窗口失焦和切换列表视图会取消尚未提交的拖动。
- 当前已置顶或不满足筛选条件的会话不会被旧预览重复显示；切换筛选、排序或视图会撤下保存中的旧预览。

验证命令：

```text
node --test tests/sidebar-drag.test.mjs tests/sidebar-organization.test.mjs tests/session-groups.test.mjs tests/session-groups-ipc.test.mjs
node tests/fixtures/model-settings/run.mjs --run --scenario=../sidebar-drag/scenarios.mjs
```

UI 场景使用独立 headless 浏览器的真实鼠标按下、移动和松开事件，覆盖连续往返、同组排序、空区与折叠区拖入、取消、保存失败、项目视图禁拖和折叠持久化；结束后清理测试浏览器及临时配置。
