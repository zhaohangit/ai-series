import { useState } from "react";
import { Check, Save, Palette } from "lucide-react";
import type { Project, Catalog } from "./types";
export default function StyleWorkspace({
  project,
  catalog,
  update,
  save,
  next,
}: {
  project: Project;
  catalog: Catalog;
  update: (patch: Partial<Project>) => void;
  save: () => void;
  next: () => void;
}) {
  const [group, setGroup] = useState("全部"),
    [custom, setCustom] = useState(false),
    [model, setModel] = useState(
      String(project.settings?.drawing_model || "生花 G2"),
    ),
    [template, setTemplate] = useState(
      String(project.settings?.drawing_template || "单特写+三视图"),
    );
  const selected = catalog.styles.find(
      (s) => String(s.id) === project.style || s.name === project.style,
    ),
    styles = catalog.styles.filter(
      (s) => group === "全部" || s.tags?.includes(group),
    );
  return (
    <div className="style-workspace">
      <aside className="style-config">
        <label>
          绘图模型
          <div className="model-select">
            <select
              aria-label="绘图模型"
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                update({
                  settings: {
                    ...project.settings,
                    drawing_model: e.target.value,
                  },
                });
              }}
            >
              {["生花 G2", "生花 T1", "Seedream 4.0", "本地配置模型"].map(
                (m) => (
                  <option key={m}>{m}</option>
                ),
              )}
            </select>
            <small>理解力更强，文字更准确，直出更真实</small>
            <span>参考模型目录 · 本地服务需配置</span>
          </div>
        </label>
        <label>
          绘图模板
          <select
            aria-label="绘图模板"
            value={template}
            onChange={(e) => {
              setTemplate(e.target.value);
              update({
                settings: {
                  ...project.settings,
                  drawing_template: e.target.value,
                },
              });
            }}
          >
            <option>单特写+三视图</option>
            <option>单特写</option>
            <option>三视图</option>
            <option>全身像</option>
          </select>
        </label>
        <h3>绘图风格</h3>
        <div className="style-radio">
          <label>
            <input
              type="radio"
              checked={!custom}
              onChange={() => setCustom(false)}
            />
            预设风格
          </label>
          <label>
            <input
              type="radio"
              checked={custom}
              onChange={() => setCustom(true)}
            />
            自定义风格
          </label>
        </div>
        {custom ? (
          <div className="style-custom">
            <textarea
              rows={6}
              placeholder="描述你希望的画面风格、色彩、质感和细节"
              value={String(project.settings?.style_prompt || "")}
              onChange={(e) =>
                update({
                  style: "自定义",
                  settings: {
                    ...project.settings,
                    style_prompt: e.target.value,
                  },
                })
              }
            />
            <p>风格描述会随作品保存，生成服务将使用这些参数。</p>
          </div>
        ) : (
          <>
            <div className="style-category">
              {[
                "全部",
                "通用",
                "现代言情",
                "古代言情",
                "科幻奇幻",
                "玄幻仙侠",
                "悬疑灵异",
                "年代历史",
                "国风武侠",
              ].map((g) => (
                <button
                  type="button"
                  key={g}
                  className={group === g ? "active" : ""}
                  onClick={() => setGroup(g)}
                >
                  {g}
                </button>
              ))}
            </div>
            <div className="style-catalog-grid" aria-label="预设风格">
              {styles.map((s) => (
                <button
                  key={s.id || s.name}
                  className={selected === s ? "active" : ""}
                  onClick={() => update({ style: String(s.id || s.name) })}
                >
                  {s.url || s.imageUrl ? (
                    <img src={s.url || s.imageUrl} alt={s.name} />
                  ) : (
                    <Palette size={30} aria-hidden="true" />
                  )}
                  <span>{s.name}</span>
                  {selected === s && <Check size={16} />}
                </button>
              ))}
            </div>
          </>
        )}
        <h3>画面比例</h3>
        <div className="style-aspects" aria-label="画面比例">
          {["16:9", "9:16", "1:1", "4:3", "3:4"].map((r) => (
            <button
              className={project.aspect_ratio === r ? "active" : ""}
              key={r}
              onClick={() => update({ aspect_ratio: r })}
            >
              {r}
            </button>
          ))}
        </div>
        <button className="primary" onClick={save}>
          <Save size={14} />
          保存设置
        </button>
      </aside>
      <section className="style-preview-area">
        <div className="style-preview">
          <h3>风格预览</h3>
          {selected ? (
            <div className="chosen-style">
              <img
                src={selected.url || selected.imageUrl}
                alt={selected.name}
              />
              <div>
                <strong>{selected.name}</strong>
                <small>参考风格图 · 实际效果由生成服务决定</small>
              </div>
            </div>
          ) : (
            <div className="style-preview-empty">
              <img src="/reference/embedded-016f974b60b1.png" alt="" />
              <p>请选择绘图风格查看风格预览图</p>
            </div>
          )}
        </div>
        <div className="preview-disclosure">以上内容由人工智能生成合成</div>
      </section>
    </div>
  );
}
