import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { ensureSession } from "./api";
import "./styles.css";
const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(<div className="loading">正在连接本地创作空间…</div>);
ensureSession()
  .then(() =>
    root.render(
      <React.StrictMode>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </React.StrictMode>,
    ),
  )
  .catch((error) =>
    root.render(
      <div className="startup-error">
        <h2>无法连接本地服务</h2>
        <p>{error.message}</p>
        <button onClick={() => location.reload()}>重新连接</button>
      </div>,
    ),
  );
