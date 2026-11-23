import base64, pathlib

base = pathlib.Path("/Users/zizi/WorkBuddy/2026-11-19-09-42-33/PDF拆页助手/Windows版")
src = base / "源码" / "lib"
template = (base / "源码" / "tool_template.html").read_text(encoding="utf-8")
pdfjs = (src / "pdf.min.js").read_text(encoding="utf-8")
worker_js = (src / "pdf.worker.min.js").read_text(encoding="utf-8")
pdflib = (src / "pdf-lib.min.js").read_text(encoding="utf-8")

# worker 用 base64 内嵌成 blob URL，避免跨文件/跨域问题
worker_b64 = base64.b64encode(worker_js.encode("utf-8")).decode("ascii")

worker_bootstrap = """
(function(){
  try {
    var b64 = "%s";
    var bin = atob(b64);
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    var blob = new Blob([bytes], {type: "application/javascript"});
    window.__PDFJS_WORKER_URL__ = URL.createObjectURL(blob);
  } catch(e) { console.error("worker init failed", e); }
})();
""" % worker_b64

html = template.replace("/* __PDFJS_LIB__ */", pdfjs)
html = html.replace("/* __PDFJS_WORKER__ */", worker_bootstrap)
html = html.replace("/* __PDFLIB__ */", pdflib)

out = base / "PDF拆页助手.html"
out.write_text(html, encoding="utf-8")
print("written:", out)
print("size:", out.stat().st_size, "bytes")
