//! Small helpers over roxmltree. HP mixes many namespace prefixes, so we match
//! on local element names only; that is unambiguous for the documents we read.

use roxmltree::Node;

pub fn children<'a, 'i>(node: Node<'a, 'i>, name: &'a str) -> impl Iterator<Item = Node<'a, 'i>> {
    node.children()
        .filter(move |n| n.is_element() && n.tag_name().name() == name)
}

pub fn descendants<'a, 'i>(
    node: Node<'a, 'i>,
    name: &'a str,
) -> impl Iterator<Item = Node<'a, 'i>> {
    node.descendants()
        .filter(move |n| n.is_element() && n.tag_name().name() == name)
}

pub fn find<'a, 'i>(node: Node<'a, 'i>, name: &str) -> Option<Node<'a, 'i>> {
    node.descendants()
        .find(|n| n.is_element() && n.tag_name().name() == name)
}

/// Trimmed text of the first descendant named `name`.
pub fn text(node: Node, name: &str) -> Option<String> {
    find(node, name)
        .and_then(|n| n.text())
        .map(|t| t.trim().to_string())
}

/// Text of the first descendant following a `/`-separated path of local names.
pub fn path_text(node: Node, path: &str) -> Option<String> {
    let mut cur = node;
    for part in path.split('/') {
        cur = children(cur, part).next()?;
    }
    cur.text().map(|t| t.trim().to_string())
}

pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_markup() {
        assert_eq!(escape("a<b>&\"c'"), "a&lt;b&gt;&amp;&quot;c&apos;");
    }

    #[test]
    fn path_text_walks_local_names() {
        let doc = roxmltree::Document::parse(
            r#"<a:r xmlns:a="x" xmlns:b="y"><b:s><a:t> hi </a:t></b:s></a:r>"#,
        )
        .unwrap();
        assert_eq!(path_text(doc.root_element(), "s/t").as_deref(), Some("hi"));
    }
}
