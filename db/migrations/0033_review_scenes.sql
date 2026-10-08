-- +goose Up
-- Diagrams attached to a review — subsumes standalone visual briefs.
-- Each entry is {title, scene: <Excalidraw JSON>} and renders inline in the
-- review card's Diagrams section.
alter table agent_reviews
    add column scenes jsonb not null default '[]';

-- +goose Down
alter table agent_reviews drop column if exists scenes;
