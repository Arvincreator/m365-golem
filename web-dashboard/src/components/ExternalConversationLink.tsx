import type { Components } from "react-markdown";

function isWebLink(href: string | undefined): boolean {
    return /^https?:\/\//i.test(String(href || "").trim());
}

export const externalConversationLinkComponents: Components = {
    a: ({ node: _node, href, children, ...props }) => {
        const external = isWebLink(href);
        return (
            <a
                {...props}
                className={["break-all [overflow-wrap:anywhere]", props.className].filter(Boolean).join(" ")}
                href={href}
                target={external ? "_blank" : props.target}
                rel={external ? "noopener noreferrer" : props.rel}
                title={external ? "在一般瀏覽器開啟" : props.title}
            >
                {children}
            </a>
        );
    },
};
