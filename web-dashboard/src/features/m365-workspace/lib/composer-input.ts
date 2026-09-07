export function shouldSubmit(event: { key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; repeat?: boolean; defaultPrevented?: boolean; isComposing?: boolean; keyCode?: number }, composing: boolean, menuOpen = false) {
    return event.key === "Enter" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
        && !event.repeat && !event.defaultPrevented && !event.isComposing && event.keyCode !== 229 && !composing && !menuOpen;
}
