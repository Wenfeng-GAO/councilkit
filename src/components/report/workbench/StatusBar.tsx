import { Link } from "react-router-dom";

export interface WorkbenchBackLink {
  to: string;
  label: string;
}

/** 28px 底栏：左侧状态文字（席位运行中 / Host 连接 / 更新失败），右侧回列表链接。 */
export function StatusBar({
  note,
  onRefetch,
  backTo,
}: {
  note: string;
  onRefetch?: () => void;
  backTo: WorkbenchBackLink;
}) {
  return (
    <footer className="ck-wb-statusbar">
      <output>
        {note}
        {onRefetch ? (
          <>
            {" · "}
            <button type="button" className="ck-wb-statusbar-action" onClick={onRefetch}>
              重新读取
            </button>
          </>
        ) : null}
      </output>
      <Link to={backTo.to}>{backTo.label}</Link>
    </footer>
  );
}
