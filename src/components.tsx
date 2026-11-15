import {
  ButtonHTMLAttributes,
  ReactNode,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { AppError } from "./api";
import { useI18n } from "./i18n";

/** Localized error text: known codes are translated, field names too. */
export function useErrorText() {
  const { t } = useI18n();
  return useCallback(
    (e: AppError) => {
      const params: Record<string, string> = { ...e.params };
      if (params.field) params.field = t(`fields.${params.field}`);
      const key = `errors.${e.code}`;
      const text = t(key, params);
      return text === key ? t("errors.unknown") : text;
    },
    [t],
  );
}

// ------------------------------------------------------------------ icons

export function Icon({ name, fill, small, className }: { name: string; fill?: boolean; small?: boolean; className?: string }) {
  return (
    <span
      className={["msr", small ? "sm" : "", className ?? ""].join(" ").trim()}
      data-fill={fill ? "" : undefined}
      aria-hidden
    >
      {name}
    </span>
  );
}

// ---------------------------------------------------------------- buttons

type ButtonVariant = "filled" | "tonal" | "outlined" | "text" | "danger" | "danger-text";

export function Button({
  variant = "filled",
  icon,
  busy,
  className,
  children,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; icon?: string; busy?: boolean }) {
  const lead = busy ? "progress_activity" : icon;
  return (
    <button
      type={type}
      className={["btn", "ripple", variant, lead ? "has-icon" : "", className ?? ""].join(" ").trim()}
      {...rest}
    >
      {lead && <Icon name={lead} className={busy ? "spin" : undefined} />}
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  variant,
  small,
  busy,
  className,
  fill,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  icon: string;
  label: string;
  variant?: "tonal";
  small?: boolean;
  busy?: boolean;
  fill?: boolean;
}) {
  return (
    <button
      type="button"
      className={["icon-btn", "ripple", variant ?? "", small ? "small" : "", className ?? ""].join(" ").trim()}
      aria-label={label}
      title={label}
      {...rest}
    >
      <Icon name={busy ? "progress_activity" : icon} fill={fill} className={busy ? "spin" : undefined} />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  full,
  label,
}: {
  value: T;
  options: { value: T; label: string; icon?: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  full?: boolean;
  label?: string;
}) {
  return (
    <div className={full ? "segmented full" : "segmented"} role="group" aria-label={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            className="ripple"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(o.value)}
          >
            {on ? <Icon name="check" /> : o.icon ? <Icon name={o.icon} /> : null}
            <span className="seg-text">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ----------------------------------------------------------------- fields

/** Outlined text field. Wraps one input, select or textarea. */
export function Field({
  label,
  hint,
  counter,
  disabled,
  dense,
  trailing,
  error,
  children,
}: {
  label: string;
  hint?: string;
  counter?: string;
  disabled?: boolean;
  dense?: boolean;
  trailing?: string;
  error?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={["tf", disabled ? "disabled" : "", dense ? "dense" : "", error ? "error" : ""].join(" ").trim()}>
      <span className="tf-box">
        {children}
        <span className="tf-label">{label}</span>
        {trailing && <Icon name={trailing} className="trailing" />}
      </span>
      {(hint || counter) && (
        <span className="tf-support">
          {hint && <span>{hint}</span>}
          {counter && <span className="counter">{counter}</span>}
        </span>
      )}
    </label>
  );
}

/** Outlined select with the M3 drop-down arrow. */
export function SelectField<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled,
  hint,
  dense,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  hint?: string;
  dense?: boolean;
}) {
  return (
    <Field label={label} hint={hint} disabled={disabled} dense={dense} trailing="arrow_drop_down">
      <select
        value={String(value)}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value;
          const match = options.find((o) => String(o.value) === raw);
          if (match) onChange(match.value);
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function Switch({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={disabled ? "switch-row disabled" : "switch-row"}>
      <span className="switch-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

// --------------------------------------------------------------- feedback

export function LinearProgress({ label }: { label?: string }) {
  return <div className="lp" role="progressbar" aria-label={label} />;
}

export function ErrorBanner({ error, onRetry }: { error: AppError | null; onRetry?: () => void }) {
  const text = useErrorText();
  const { t } = useI18n();
  if (!error) return null;
  return (
    <div className="banner" role="alert" title={error.message}>
      <Icon name="error" />
      <p className="banner-text">{text(error)}</p>
      {onRetry && (
        <Button variant="text" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  error,
  children,
}: {
  icon: string;
  title: string;
  body?: ReactNode;
  error?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={error ? "empty-state error" : "empty-state"}>
      <div className="empty-icon">
        <Icon name={icon} />
      </div>
      <h2 className="title-l">{title}</h2>
      {body && <p>{body}</p>}
      {children && <div className="row wrap">{children}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  lead,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  lead?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="page-head">
      {lead}
      <div className="grow">
        <h1>{title}</h1>
        {subtitle && <div className="subtitle">{subtitle}</div>}
      </div>
      {children && <div className="page-head-actions">{children}</div>}
    </header>
  );
}

// ----------------------------------------------------------------- dialog

export function Dialog({
  open,
  onClose,
  title,
  icon,
  small,
  actions,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  icon?: string;
  small?: boolean;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={small ? "dialog small" : "dialog"}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // click on the backdrop closes
        if (e.target === ref.current) onClose();
      }}
      aria-labelledby="dlg-title"
    >
      {open && (
        <>
          {icon && <Icon name={icon} className="dialog-icon" />}
          <h2 className="dialog-title" id="dlg-title">
            {title}
          </h2>
          {children && <div className="dialog-body">{children}</div>}
          {actions && <div className="dialog-actions">{actions}</div>}
        </>
      )}
    </dialog>
  );
}

/** Two-button confirmation dialog for destructive actions. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirm,
  icon = "delete",
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirm: string;
  icon?: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      icon={icon}
      small
      actions={
        <>
          <Button variant="text" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger-text" onClick={onConfirm} busy={busy} disabled={busy}>
            {confirm}
          </Button>
        </>
      }
    >
      {body}
    </Dialog>
  );
}
