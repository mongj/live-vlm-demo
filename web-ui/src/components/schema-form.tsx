"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  resolveSchema,
  schemaType,
  stringEnumValues,
  type JsonSchema,
} from "@/lib/json-schema";

type SchemaFormProps = {
  schema: JsonSchema;
  values: Record<string, unknown>;
  disabled?: boolean;
  disabledFields?: readonly string[];
  errors?: Record<string, string>;
  strictNumbers?: boolean;
  onChange: (key: string, value: unknown) => void;
};

function fieldId(name: string) {
  return `config-${name}`;
}

function SchemaField({
  name,
  schema,
  root,
  value,
  disabled,
  error,
  strictNumbers,
  onChange,
}: {
  name: string;
  schema: JsonSchema;
  root: JsonSchema;
  value: unknown;
  disabled?: boolean;
  error?: string;
  strictNumbers?: boolean;
  onChange: (key: string, value: unknown) => void;
}) {
  const field = resolveSchema(schema, root);
  const type = schemaType(field);
  const title = field.title ?? name;
  const description = field.description;
  const enums = stringEnumValues(field);
  const id = fieldId(name);

  if (type === "object" && field.properties) {
    return (
      <div className="min-w-0 space-y-3 overflow-visible">
        <div className="min-w-0 space-y-1">
          <p className="truncate text-sm font-medium">{title}</p>
          {description ? (
            <p className="text-xs wrap-break-word text-muted-foreground">{description}</p>
          ) : null}
        </div>
        <div className="min-w-0 space-y-3 pl-1">
          {Object.entries(field.properties).map(([childName, childSchema]) => (
            <SchemaField
              disabled={disabled}
              key={childName}
              name={childName}
              onChange={onChange}
              root={root}
              schema={childSchema}
              value={
                value && typeof value === "object" && !Array.isArray(value)
                  ? (value as Record<string, unknown>)[childName]
                  : undefined
              }
            />
          ))}
        </div>
      </div>
    );
  }

  if (type === "boolean") {
    return (
      <div className="flex min-w-0 items-start justify-between gap-3 overflow-visible">
        <div className="min-w-0 space-y-1 overflow-hidden">
          <Label className="block truncate" htmlFor={id}>
            {title}
          </Label>
          {description ? (
            <p className="text-xs wrap-break-word text-muted-foreground">{description}</p>
          ) : null}
        </div>
        <Switch
          checked={Boolean(value)}
          disabled={disabled}
          id={id}
          onCheckedChange={(checked) => onChange(name, checked)}
        />
      </div>
    );
  }

  if (enums) {
    const current = typeof value === "string" && enums.includes(value) ? value : (enums[0] ?? "");
    return (
      <div className="min-w-0 space-y-1.5 overflow-visible">
        <Label className="block truncate" htmlFor={id}>
          {title}
        </Label>
        <Select
          disabled={disabled}
          onValueChange={(next) => onChange(name, next)}
          value={current}
        >
          <SelectTrigger className="w-full min-w-0" id={id}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start" position="popper">
            <SelectGroup>
            {enums.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {description ? (
          <p className="text-xs wrap-break-word text-muted-foreground">{description}</p>
        ) : null}
      </div>
    );
  }

  if (type === "integer" || type === "number") {
    const numeric = strictNumbers && typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? value : (field.default as number | undefined) ?? field.minimum ?? 0;
    return (
      <div className="min-w-0 space-y-1.5 overflow-visible">
        <Label className="block truncate" htmlFor={id}>
          {title}
        </Label>
        <Input
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
          disabled={disabled}
          id={id}
          max={field.maximum}
          min={field.minimum}
          onChange={(event) => {
            const raw = event.target.value;
            if (raw === "") {
              if (strictNumbers) onChange(name, "");
              return;
            }
            const next = strictNumbers ? Number(raw) : type === "integer" ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
            if (Number.isFinite(next)) {
              onChange(name, next);
            } else if (strictNumbers) onChange(name, raw);
          }}
          step={type === "integer" ? 1 : "any"}
          type="number"
          value={numeric}
        />
        {error ? <p className="text-xs text-destructive" id={`${id}-error`}>{error}</p> : null}
        {description ? (
          <p className="text-xs wrap-break-word text-muted-foreground">{description}</p>
        ) : null}
      </div>
    );
  }

  if (type === "string") {
    return (
      <div className="min-w-0 space-y-1.5 overflow-visible">
        <Label className="block truncate" htmlFor={id}>
          {title}
        </Label>
        <Input
          disabled={disabled}
          id={id}
          onChange={(event) => onChange(name, event.target.value)}
          type="text"
          value={typeof value === "string" ? value : ""}
        />
        {description ? (
          <p className="text-xs wrap-break-word text-muted-foreground">{description}</p>
        ) : null}
      </div>
    );
  }

  return null;
}

export function SchemaForm({ schema, values, disabled, disabledFields, errors, strictNumbers, onChange }: SchemaFormProps) {
  const resolved = resolveSchema(schema, schema);
  const properties = resolved.properties;
  if (!properties || Object.keys(properties).length === 0) {
    return <p className="text-xs text-muted-foreground">This model has no configurable fields.</p>;
  }

  return (
    <div className="min-w-0 space-y-4 overflow-visible">
      {Object.entries(properties).map(([name, fieldSchema]) => (
        <SchemaField
          disabled={disabled || disabledFields?.includes(name)}
          error={errors?.[name]}
          strictNumbers={strictNumbers}
          key={name}
          name={name}
          onChange={onChange}
          root={schema}
          schema={fieldSchema}
          value={values[name]}
        />
      ))}
    </div>
  );
}
