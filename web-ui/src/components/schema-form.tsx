"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
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
  onChange,
}: {
  name: string;
  schema: JsonSchema;
  root: JsonSchema;
  value: unknown;
  disabled?: boolean;
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
      <div className="min-w-0 space-y-3 overflow-hidden">
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
      <div className="flex min-w-0 items-start justify-between gap-3 overflow-hidden">
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
      <div className="min-w-0 space-y-1.5 overflow-hidden">
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
            {enums.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {description ? (
          <p className="text-xs wrap-break-word text-muted-foreground">{description}</p>
        ) : null}
      </div>
    );
  }

  if (type === "integer" || type === "number") {
    const numeric = typeof value === "number" && Number.isFinite(value) ? value : (field.default as number | undefined) ?? field.minimum ?? 0;
    return (
      <div className="min-w-0 space-y-1.5 overflow-hidden">
        <Label className="block truncate" htmlFor={id}>
          {title}
        </Label>
        <Input
          disabled={disabled}
          id={id}
          max={field.maximum}
          min={field.minimum}
          onChange={(event) => {
            const raw = event.target.value;
            if (raw === "") {
              return;
            }
            const next = type === "integer" ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
            if (Number.isFinite(next)) {
              onChange(name, next);
            }
          }}
          step={type === "integer" ? 1 : "any"}
          type="number"
          value={numeric}
        />
        {description ? (
          <p className="text-xs wrap-break-word text-muted-foreground">{description}</p>
        ) : null}
      </div>
    );
  }

  if (type === "string") {
    return (
      <div className="min-w-0 space-y-1.5 overflow-hidden">
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

export function SchemaForm({ schema, values, disabled, onChange }: SchemaFormProps) {
  const resolved = resolveSchema(schema, schema);
  const properties = resolved.properties;
  if (!properties || Object.keys(properties).length === 0) {
    return <p className="text-xs text-muted-foreground">This model has no configurable fields.</p>;
  }

  return (
    <div className="min-w-0 space-y-4 overflow-hidden">
      {Object.entries(properties).map(([name, fieldSchema]) => (
        <SchemaField
          disabled={disabled}
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
