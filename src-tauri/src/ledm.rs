//! HP LEDM ("Low End Data Model") endpoints: device info, status, toner,
//! scan-to-email profiles and scan-to-email defaults.
//!
//! Element names and order come from the printer's own `*Cap.xml` documents
//! (see `EmailAccountsCap.xml` and `ScanToEmailCap.xml` on the device).

use roxmltree::Document;
use serde::{Deserialize, Serialize};

use crate::client::Printer;
use crate::error::{Error, Result};
use crate::xml::{children, descendants, escape, find, path_text, text};

const NS: &str = concat!(
    r#"xmlns:dd="http://www.hp.com/schemas/imaging/con/dictionaries/1.0/" "#,
    r#"xmlns:dd3="http://www.hp.com/schemas/imaging/con/dictionaries/2009/04/06" "#,
    r#"xmlns:dsd="http://www.hp.com/schemas/imaging/con/digitalsending/2009/02/11" "#,
    r#"xmlns:dsd2="http://www.hp.com/schemas/imaging/con/digitalsending/2010/11/22" "#,
    r#"xmlns:emaildyn="http://www.hp.com/schemas/imaging/con/ledm/emailservicedyn/2010/11/22" "#,
    r#"xmlns:security="http://www.hp.com/schemas/imaging/con/security/2009/02/11""#,
);

const ACCOUNTS: &str = "/DevMgmt/Email/Accounts";
const SCAN_TO_EMAIL_DYN: &str = "/DevMgmt/Email/ScanToEmailDyn.xml";
const SCAN_TO_EMAIL_CAP: &str = "/DevMgmt/Email/ScanToEmailCap.xml";

// ---------------------------------------------------------------- overview

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub model: Option<String>,
    pub product_number: Option<String>,
    pub serial_number: Option<String>,
    pub firmware_date: Option<String>,
    pub status: Option<String>,
    pub status_message: Option<String>,
    pub alerts: Vec<Alert>,
    pub consumables: Vec<Consumable>,
}

/// Device alert. `id` is a stable keyword (e.g. `cartridgeLow`) that the UI
/// translates; `message` is the device's own localized text when it has one.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    pub id: Option<String>,
    pub message: Option<String>,
    pub severity: Option<String>,
    /// Marker color the alert refers to (e.g. `Black`), if any.
    pub color: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Consumable {
    pub label: String,
    pub name: Option<String>,
    pub percent: Option<u8>,
    pub state: Option<String>,
    pub cartridge: Option<String>,
    /// Retail cartridge name, e.g. `304XL`, `131A`.
    pub selectibility: Option<String>,
    pub estimated_pages: Option<u32>,
}

pub async fn overview(p: &Printer) -> Result<Overview> {
    let (cfg, status, cons) = tokio::join!(
        p.get_text("/DevMgmt/ProductConfigDyn.xml"),
        p.get_text("/DevMgmt/ProductStatusDyn.xml"),
        p.get_text("/DevMgmt/ConsumableConfigDyn.xml"),
    );
    let cfg = cfg?;
    let cfg = Document::parse(&cfg)?;
    let root = cfg.root_element();

    let mut out = Overview {
        model: text(root, "MakeAndModel"),
        product_number: text(root, "ProductNumber"),
        serial_number: text(root, "SerialNumber"),
        firmware_date: text(root, "Date"),
        status: None,
        status_message: None,
        alerts: vec![],
        consumables: vec![],
    };

    // Status and consumables are best-effort: show what we can.
    if let Ok(xml) = status {
        if let Ok(doc) = Document::parse(&xml) {
            let r = doc.root_element();
            // Several Status entries may exist (e.g. cartridgeLow + inPowerSave);
            // the alerts carry the problems, so report the least alarming one
            // as the state and rely on the alert list for the rest.
            let statuses: Vec<_> = children(r, "Status").collect();
            if let Some(st) = statuses.last() {
                out.status = text(*st, "StatusCategory");
                out.status_message = text(*st, "LocString");
            }
            if let Some(table) = find(r, "AlertTable") {
                out.alerts = descendants(table, "Alert")
                    .map(|a| Alert {
                        id: text(a, "ProductStatusAlertID"),
                        message: text(a, "LocString"),
                        severity: text(a, "Severity"),
                        color: text(a, "AlertDetailsMarkerColor"),
                    })
                    .filter(|a| a.id.is_some() || a.message.is_some())
                    .collect();
            }
        }
    }
    if let Ok(xml) = cons {
        if let Ok(doc) = Document::parse(&xml) {
            out.consumables = parse_consumables(&doc);
        }
    }
    Ok(out)
}

fn parse_consumables(doc: &Document) -> Vec<Consumable> {
    descendants(doc.root_element(), "ConsumableInfo")
        .filter_map(|c| {
            Some(Consumable {
                label: path_text(c, "ConsumableLabelCode")?,
                name: path_text(c, "ConsumableFamilyName"),
                percent: path_text(c, "ConsumablePercentageLevelRemaining")
                    .and_then(|v| v.parse().ok()),
                state: path_text(c, "ConsumableLifeState/ConsumableState"),
                cartridge: path_text(c, "ProductNumber"),
                selectibility: path_text(c, "ConsumableSelectibilityNumber"),
                estimated_pages: path_text(c, "ConsumableEstimatedPages/ValueInt")
                    .and_then(|v| v.parse().ok()),
            })
        })
        .collect()
}

fn too_long(field: &str, max: usize) -> Error {
    Error::invalid_with("too_long", &[("field", field.into()), ("max", max.to_string())])
}

// ---------------------------------------------------------- email accounts

/// One outgoing-mail profile stored on the printer (max 20).
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct EmailAccount {
    /// Printer-assigned entry id; `None` for a new profile.
    pub id: Option<String>,
    pub display_name: String,
    pub email_address: String,
    pub smtp_server: String,
    pub port: u16,
    /// MB, 0 = no limit.
    pub max_attachment_size: u16,
    pub use_ssl: bool,
    pub cc_to_self: bool,
    /// Empty/None = no SMTP authentication.
    pub username: Option<String>,
    /// Write-only on the printer. `None` on update keeps the stored one.
    pub password: Option<String>,
    /// Optional 4-digit PIN protecting the profile. Write-only.
    pub pin: Option<String>,
}

pub mod limits {
    pub const DISPLAY_NAME: usize = 25;
    pub const EMAIL: usize = 50;
    pub const SMTP_SERVER: usize = 100;
    pub const USERNAME: usize = 50;
    pub const PASSWORD: usize = 50;
    pub const MAX_ACCOUNTS: usize = 20;
    pub const MAX_ATTACHMENT_MB: u16 = 999;
}

impl EmailAccount {
    pub fn validate(&self) -> Result<()> {
        fn check(field: &str, v: &str, max: usize, required: bool) -> Result<()> {
            if required && v.trim().is_empty() {
                return Err(Error::invalid_with("required", &[("field", field.into())]));
            }
            if v.chars().count() > max {
                return Err(too_long(field, max));
            }
            Ok(())
        }
        check("displayName", &self.display_name, limits::DISPLAY_NAME, true)?;
        check("emailAddress", &self.email_address, limits::EMAIL, true)?;
        if !self.email_address.contains('@') {
            return Err(Error::invalid("email_invalid"));
        }
        check("smtpServer", &self.smtp_server, limits::SMTP_SERVER, true)?;
        if self.port == 0 {
            return Err(Error::invalid("port_range"));
        }
        if self.max_attachment_size > limits::MAX_ATTACHMENT_MB {
            return Err(Error::invalid("attachment_range"));
        }
        if let Some(u) = &self.username {
            check("username", u, limits::USERNAME, false)?;
        }
        if let Some(pw) = &self.password {
            check("password", pw, limits::PASSWORD, false)?;
        }
        if let Some(pin) = self.pin.as_deref().filter(|p| !p.is_empty()) {
            if pin.len() != 4 || !pin.chars().all(|c| c.is_ascii_digit()) {
                return Err(Error::invalid("pin_format"));
            }
        }
        Ok(())
    }

    fn to_xml(&self) -> String {
        let mut auth = String::new();
        if let Some(user) = self.username.as_deref().filter(|u| !u.is_empty()) {
            auth.push_str("<security:AuthenticationSettings><security:SimpleAuthenticationSettings>");
            auth.push_str(&format!("<dd:UserName>{}</dd:UserName>", escape(user)));
            if let Some(pw) = &self.password {
                auth.push_str(&format!("<dd:Password>{}</dd:Password>", escape(pw)));
            }
            auth.push_str("</security:SimpleAuthenticationSettings></security:AuthenticationSettings>");
        }
        let pin = self
            .pin
            .as_deref()
            .filter(|p| !p.is_empty())
            .map(|p| format!("<dd:PIN>{p}</dd:PIN>"))
            .unwrap_or_default();
        format!(
            concat!(
                r#"<?xml version="1.0" encoding="UTF-8"?>"#,
                "<emaildyn:EmailAccount {ns}>",
                "<dd:DisplayName>{name}</dd:DisplayName>",
                "<dd:EmailAddress>{addr}</dd:EmailAddress>",
                "<dsd2:SMTPServerSettings>",
                "<dd3:NetworkID>{server}</dd3:NetworkID>",
                "<dd:Port>{port}</dd:Port>",
                "<dd:MaxAttachmentSize>{max}</dd:MaxAttachmentSize>",
                "{auth}",
                "<dd:UseSSL>{ssl}</dd:UseSSL>",
                "<emaildyn:EmailCopy>{copy}</emaildyn:EmailCopy>",
                "</dsd2:SMTPServerSettings>",
                "{pin}",
                "</emaildyn:EmailAccount>",
            ),
            ns = NS,
            name = escape(self.display_name.trim()),
            addr = escape(self.email_address.trim()),
            server = escape(self.smtp_server.trim()),
            port = self.port,
            max = self.max_attachment_size,
            auth = auth,
            ssl = self.use_ssl,
            copy = if self.cc_to_self { "CcToSelf" } else { "NoCopy" },
            pin = pin,
        )
    }
}

/// The entry id element name is not documented in the capability file, so
/// accept the common LEDM spellings.
fn entry_id(node: roxmltree::Node) -> Option<String> {
    node.children()
        .filter(|n| n.is_element())
        .find(|n| {
            let name = n.tag_name().name();
            matches!(name, "EntryID" | "EntryId" | "Id" | "ID" | "ResourceId")
                || name.ends_with("EntryID")
                || name.ends_with("EntryId")
        })
        .and_then(|n| n.text())
        .map(|t| t.trim().to_string())
}

fn parse_accounts(xml: &str) -> Result<Vec<EmailAccount>> {
    let doc = Document::parse(xml)?;
    Ok(descendants(doc.root_element(), "EmailAccount")
        .map(|a| {
            let smtp = find(a, "SMTPServerSettings");
            let s = |name: &str| smtp.and_then(|n| text(n, name));
            EmailAccount {
                id: entry_id(a),
                display_name: path_text(a, "DisplayName").unwrap_or_default(),
                email_address: path_text(a, "EmailAddress").unwrap_or_default(),
                smtp_server: s("NetworkID").unwrap_or_default(),
                port: s("Port").and_then(|v| v.parse().ok()).unwrap_or(25),
                max_attachment_size: s("MaxAttachmentSize")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0),
                use_ssl: s("UseSSL").as_deref() == Some("true"),
                cc_to_self: s("EmailCopy").as_deref() == Some("CcToSelf"),
                username: s("UserName").filter(|u| !u.is_empty()),
                password: None,
                pin: None,
            }
        })
        .collect())
}

fn account_path(id: &str) -> Result<String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(Error::invalid_with("bad_id", &[("id", id.into())]));
    }
    Ok(format!("{ACCOUNTS}/{id}"))
}

pub async fn list_accounts(p: &Printer) -> Result<Vec<EmailAccount>> {
    parse_accounts(&p.get_text(ACCOUNTS).await?)
}

/// Returns the new entry id when the printer reports it via `Location`.
pub async fn create_account(p: &Printer, acc: &EmailAccount) -> Result<Option<String>> {
    acc.validate()?;
    let existing = list_accounts(p).await?;
    if existing.len() >= limits::MAX_ACCOUNTS {
        return Err(Error::invalid_with(
            "profiles_full",
            &[("max", limits::MAX_ACCOUNTS.to_string())],
        ));
    }
    let created = p.post_xml(ACCOUNTS, acc.to_xml()).await?;
    Ok(created
        .location
        .and_then(|l| l.rsplit('/').next().map(str::to_string)))
}

pub async fn update_account(p: &Printer, id: &str, acc: &EmailAccount) -> Result<()> {
    acc.validate()?;
    p.put_xml(&account_path(id)?, acc.to_xml()).await
}

pub async fn delete_account(p: &Printer, id: &str) -> Result<()> {
    p.delete(&account_path(id)?).await
}

/// Ask the printer to contact the SMTP server, then poll for the verdict.
pub async fn test_account(p: &Printer, id: &str) -> Result<String> {
    let base = account_path(id)?;
    p.post_xml(&format!("{base}/test"), String::new()).await?;
    let mut last = String::from("unknown");
    for _ in 0..20 {
        tokio::time::sleep(std::time::Duration::from_millis(750)).await;
        let xml = p.get_text(&format!("{base}/test-result")).await?;
        let doc = Document::parse(&xml)?;
        let root = doc.root_element();
        let code = text(root, "TestStatusCode")
            .or_else(|| root.text().map(|t| t.trim().to_string()))
            .unwrap_or_default();
        if code.is_empty() {
            continue;
        }
        last = code;
        let lc = last.to_ascii_lowercase();
        if !(lc.contains("progress") || lc.contains("pending") || lc.contains("processing")) {
            break;
        }
    }
    Ok(last)
}

// ------------------------------------------------- scan-to-email defaults

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanToEmailSettings {
    pub enabled: bool,
    pub default_body_enabled: bool,
    pub subject: String,
    pub body: String,
    pub media_size: String,
    pub color: String,
    pub file_type: String,
    pub resolution: String,
    pub file_name_prefix: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanToEmailOptions {
    pub media_sizes: Vec<String>,
    pub colors: Vec<String>,
    pub file_types: Vec<String>,
    pub resolutions: Vec<String>,
    pub subject_max: usize,
    pub body_max: usize,
    pub prefix_max: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanToEmailConfig {
    pub settings: ScanToEmailSettings,
    pub options: ScanToEmailOptions,
}

fn parse_options(xml: &str) -> Result<ScanToEmailOptions> {
    let doc = Document::parse(xml)?;
    let root = doc.root_element();
    let values = |support: &str, item: &str| -> Vec<String> {
        find(root, support)
            .map(|n| {
                children(n, item)
                    .filter_map(|c| c.text().map(|t| t.trim().to_string()))
                    .collect()
            })
            .unwrap_or_default()
    };
    let len = |support: &str, default: usize| -> usize {
        find(root, support)
            .and_then(|n| n.attribute("length"))
            .and_then(|v| v.parse().ok())
            .unwrap_or(default)
    };
    Ok(ScanToEmailOptions {
        media_sizes: values("ScanMediaSizeSupport", "ScanMediaSize"),
        colors: values("DSColorPreferenceSupport", "DSColorPreference"),
        file_types: values("DSFileTypeSupport", "DSFileType"),
        resolutions: values("DSImageResolutionSupport", "DSImageResolution"),
        subject_max: len("EmailSubjectSupport", 80),
        body_max: len("EmailBodyTextSupport", 512),
        prefix_max: len("FileNamePrefixSupport", 20),
    })
}

fn parse_settings(xml: &str) -> Result<ScanToEmailSettings> {
    let doc = Document::parse(xml)?;
    let r = doc.root_element();
    let t = |name: &str| text(r, name).unwrap_or_default();
    Ok(ScanToEmailSettings {
        enabled: t("FeatureScanToEmail") == "enabled",
        default_body_enabled: t("FeatureDefaultBodyText") == "enabled",
        subject: t("EmailSubject"),
        body: t("EmailBodyText"),
        media_size: t("ScanMediaSize"),
        color: t("DSColorPreference"),
        file_type: t("DSFileType"),
        resolution: t("DSImageResolution"),
        file_name_prefix: t("FileNamePrefix"),
    })
}

pub async fn get_scan_to_email(p: &Printer) -> Result<ScanToEmailConfig> {
    let (dyn_xml, cap_xml) = tokio::join!(
        p.get_text(SCAN_TO_EMAIL_DYN),
        p.get_text(SCAN_TO_EMAIL_CAP)
    );
    Ok(ScanToEmailConfig {
        settings: parse_settings(&dyn_xml?)?,
        options: parse_options(&cap_xml?)?,
    })
}

pub async fn set_scan_to_email(p: &Printer, s: &ScanToEmailSettings) -> Result<()> {
    let opts = parse_options(&p.get_text(SCAN_TO_EMAIL_CAP).await?)?;
    let one_of = |field: &str, v: &str, allowed: &[String]| -> Result<()> {
        if allowed.is_empty() || allowed.iter().any(|a| a == v) {
            Ok(())
        } else {
            Err(Error::invalid_with("unsupported_value", &[("field", field.into()), ("value", v.into())]))
        }
    };
    one_of("mediaSize", &s.media_size, &opts.media_sizes)?;
    one_of("color", &s.color, &opts.colors)?;
    one_of("fileType", &s.file_type, &opts.file_types)?;
    one_of("resolution", &s.resolution, &opts.resolutions)?;
    for (field, v, max) in [
        ("subject", &s.subject, opts.subject_max),
        ("body", &s.body, opts.body_max),
        ("fileNamePrefix", &s.file_name_prefix, opts.prefix_max),
    ] {
        if v.chars().count() > max {
            return Err(too_long(field, max));
        }
    }
    let on = |b: bool| if b { "enabled" } else { "disabled" };
    let xml = format!(
        concat!(
            r#"<?xml version="1.0" encoding="UTF-8"?>"#,
            "<emaildyn:ScanToEmailDyn {ns}>",
            "<emaildyn:FeatureScanToEmail>{en}</emaildyn:FeatureScanToEmail>",
            "<emaildyn:FeatureDefaultBodyText>{body_en}</emaildyn:FeatureDefaultBodyText>",
            "<dd:EmailSubject>{subject}</dd:EmailSubject>",
            "<dd:EmailBodyText>{body}</dd:EmailBodyText>",
            "<dsd:ScanSettings><dd:ScanMediaSize>{media}</dd:ScanMediaSize></dsd:ScanSettings>",
            "<dsd:AttachmentSettings>",
            "<dd:DSColorPreference>{color}</dd:DSColorPreference>",
            "<dd:DSFileType>{ftype}</dd:DSFileType>",
            "<dd:DSImageResolution>{res}</dd:DSImageResolution>",
            "<dd:FileNamePrefix>{prefix}</dd:FileNamePrefix>",
            "</dsd:AttachmentSettings>",
            "</emaildyn:ScanToEmailDyn>",
        ),
        ns = NS,
        en = on(s.enabled),
        body_en = on(s.default_body_enabled),
        subject = escape(&s.subject),
        body = escape(&s.body),
        media = escape(&s.media_size),
        color = escape(&s.color),
        ftype = escape(&s.file_type),
        res = escape(&s.resolution),
        prefix = escape(&s.file_name_prefix),
    );
    p.put_xml(SCAN_TO_EMAIL_DYN, xml).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> EmailAccount {
        EmailAccount {
            id: None,
            display_name: "Office & Co".into(),
            email_address: "scan@example.com".into(),
            smtp_server: "smtp.example.com".into(),
            port: 587,
            max_attachment_size: 10,
            use_ssl: true,
            cc_to_self: false,
            username: Some("scan".into()),
            password: Some("p<w>".into()),
            pin: None,
        }
    }

    #[test]
    fn account_xml_roundtrips_through_parser() {
        let xml = sample().to_xml();
        assert!(xml.contains("Office &amp; Co"));
        assert!(xml.contains("<dd:Password>p&lt;w&gt;</dd:Password>"));
        let wrapped = xml.replacen(
            "<emaildyn:EmailAccount ",
            &format!("<emaildyn:EmailAccounts {NS}><emaildyn:EmailAccount "),
            1,
        ) + "</emaildyn:EmailAccounts>";
        let wrapped = wrapped.replacen(r#"<?xml version="1.0" encoding="UTF-8"?>"#, "", 1);
        let parsed = parse_accounts(&wrapped).unwrap();
        assert_eq!(parsed.len(), 1);
        let a = &parsed[0];
        assert_eq!(a.display_name, "Office & Co");
        assert_eq!(a.smtp_server, "smtp.example.com");
        assert_eq!(a.port, 587);
        assert!(a.use_ssl);
        assert_eq!(a.username.as_deref(), Some("scan"));
        assert!(a.password.is_none(), "password must never be read back");
    }

    #[test]
    fn no_auth_block_without_username() {
        let mut a = sample();
        a.username = None;
        assert!(!a.to_xml().contains("AuthenticationSettings"));
    }

    #[test]
    fn validation_rejects_bad_input() {
        let mut a = sample();
        a.display_name = "x".repeat(26);
        assert!(a.validate().is_err());
        let mut a = sample();
        a.pin = Some("12a4".into());
        assert!(a.validate().is_err());
        let mut a = sample();
        a.email_address = "nope".into();
        assert!(a.validate().is_err());
        assert!(sample().validate().is_ok());
    }

    #[test]
    fn rejects_path_injection_in_id() {
        assert!(account_path("../Security").is_err());
        assert!(account_path("3").is_ok());
    }

    #[test]
    fn parses_real_consumables() {
        let xml = r#"<ccdyn:ConsumableConfigDyn xmlns:ccdyn="a" xmlns:dd="b"><ccdyn:ConsumableInfo>
            <dd:ConsumableFamilyName>Black toner supply</dd:ConsumableFamilyName>
            <dd:ConsumableLabelCode>K</dd:ConsumableLabelCode>
            <dd:ConsumableLifeState><dd:ConsumableState>ok</dd:ConsumableState></dd:ConsumableLifeState>
            <dd:ConsumablePercentageLevelRemaining>42</dd:ConsumablePercentageLevelRemaining>
            <dd:Manufacturer><dd:Name></dd:Name></dd:Manufacturer>
            <dd:ProductNumber>CF210X</dd:ProductNumber>
            <dd:ConsumableEstimatedPages><dd:ValueInt>2500</dd:ValueInt></dd:ConsumableEstimatedPages>
            </ccdyn:ConsumableInfo></ccdyn:ConsumableConfigDyn>"#;
        let doc = Document::parse(xml).unwrap();
        let c = parse_consumables(&doc);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].label, "K");
        assert_eq!(c[0].percent, Some(42));
        assert_eq!(c[0].cartridge.as_deref(), Some("CF210X"));
        assert_eq!(c[0].estimated_pages, Some(2500));
    }
}
